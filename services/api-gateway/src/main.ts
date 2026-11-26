/**
 * api-gateway: the single entry point for the browser and the traffic generator.
 * (Routes can require a role via `role`; none do today, the hook is there for labs.)
 *
 *  - verifies the JWT (RS256, keys from auth-service JWKS, cached)
 *  - strips any client-supplied x-user-* headers and sets trusted ones
 *  - per-user / per-IP rate limiting
 *  - routes /api/<prefix>/* to the upstream service
 *
 * The gateway's server span is the root of every backend trace.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createServer, start, logger, metrics, trace, env, envNumber } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const ISSUER = env("JWT_ISSUER", "http://shop.local/api/auth");
const AUDIENCE = env("JWT_AUDIENCE", "shop-api");
const JWKS = createRemoteJWKSet(new URL(env("AUTH_JWKS_URL", "http://auth:8080/.well-known/jwks.json")), {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});
const RATE_LIMIT_PER_MINUTE = envNumber("RATE_LIMIT_PER_MINUTE", 600);
const UPSTREAM_TIMEOUT_MS = envNumber("UPSTREAM_TIMEOUT_MS", 15_000);

type AuthMode = "none" | "optional" | "required";
interface Route {
  prefix: string;
  upstream: string;
  /** Part of the path removed before forwarding (default: the whole prefix). */
  strip?: string;
  auth: AuthMode;
  role?: string;
  methods?: string[];
  headers?: Record<string, string>;
}

const routes: Route[] = [
  { prefix: "/api/auth", upstream: env("AUTH_URL", "http://auth:8080"), auth: "none" },
  { prefix: "/api/catalog", upstream: env("CATALOG_URL", "http://catalog:8080"), auth: "optional", methods: ["GET"] },
  { prefix: "/api/inventory", upstream: env("INVENTORY_URL", "http://inventory:8080"), auth: "optional", methods: ["GET"] },
  // cart and order own their resource paths (/cart/..., /orders/...): only "/api" is removed.
  { prefix: "/api/cart", upstream: env("CART_URL", "http://cart:8080"), strip: "/api", auth: "required" },
  { prefix: "/api/orders", upstream: env("ORDER_URL", "http://order:8080"), strip: "/api", auth: "required" },
];

const meter = metrics.getMeter("api-gateway");
const authFailures = meter.createCounter("shop_gateway_auth_failures_total", { description: "Rejected tokens by reason" });
const rateLimited = meter.createCounter("shop_gateway_rate_limited_total", { description: "Requests rejected by the rate limiter" });
const upstreamErrors = meter.createCounter("shop_gateway_upstream_errors_total", { description: "Upstream unreachable/timeout" });

// --- rate limiting: fixed one-minute window per user (or per IP when anonymous) ---------
const windows = new Map<string, { start: number; count: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now - w.start > 60_000) windows.delete(k);
}, 60_000).unref();

function allow(key: string): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start > 60_000) {
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= RATE_LIMIT_PER_MINUTE;
}

interface Identity {
  id: string;
  email: string;
  roles: string[];
}

function reasonOf(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "expired";
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "bad_signature";
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `claim_${err.claim}`;
  if (err instanceof joseErrors.JWKSNoMatchingKey) return "unknown_key";
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return "malformed";
  return "invalid";
}

async function authenticate(req: FastifyRequest, reply: FastifyReply, mode: AuthMode): Promise<Identity | null | undefined> {
  const header = req.headers.authorization;
  if (!header) {
    if (mode === "required") {
      authFailures.add(1, { reason: "missing" });
      logger.warn({ requestId: req.id, url: req.url, event: "auth.token_missing" }, `rejected ${req.method} ${req.url.split("?")[0]}: no bearer token`);
      reply.status(401).header("www-authenticate", 'Bearer realm="shop"').send({ error: "unauthenticated", message: "bearer token required" });
      return undefined;
    }
    return null;
  }
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: AUDIENCE });
    return { id: String(payload.sub), email: String(payload.email ?? ""), roles: (payload.roles as string[]) ?? [] };
  } catch (err) {
    const reason = reasonOf(err);
    authFailures.add(1, { reason });
    trace.getActiveSpan()?.setAttribute("auth.failure_reason", reason);
    logger.warn({ requestId: req.id, url: req.url, reason, ip: req.ip, event: "auth.token_rejected" }, `rejected ${req.method} ${req.url.split("?")[0]}: invalid token (${reason}) from ${req.ip}`);
    reply
      .status(401)
      .header("www-authenticate", `Bearer realm="shop", error="invalid_token"`)
      .send({ error: "invalid_token", message: `token rejected: ${reason}` });
    return undefined;
  }
}

const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade",
  "traceparent", "tracestate", "baggage", // re-injected by the OpenTelemetry fetch instrumentation
]);
const PASS_BACK = ["content-type", "cache-control", "location", "www-authenticate", "retry-after", "etag"];

const app = createServer();

// The gateway forwards bodies untouched, so read every content type as a raw buffer.
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

app.all("/api/*", async (req, reply) => {
  const path = req.url.split("?")[0];
  const route = routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
  if (!route) return reply.status(404).send({ error: "not_found", message: `no route for ${path}` });

  const span = trace.getActiveSpan();
  span?.updateName(`${req.method} ${route.prefix}/*`);
  span?.setAttribute("http.route", `${route.prefix}/*`);
  span?.setAttribute("gateway.upstream", route.upstream);

  if (route.methods && !route.methods.includes(req.method)) {
    return reply.status(405).send({ error: "method_not_allowed", message: `${req.method} not allowed on ${route.prefix}` });
  }

  const user = await authenticate(req, reply, route.auth);
  if (user === undefined) return reply; // already answered 401
  if (user) span?.setAttribute("enduser.id", user.id);

  if (route.role && !user?.roles.includes(route.role)) {
    logger.warn({ requestId: req.id, userId: user?.id, required: route.role, event: "auth.forbidden" }, `rejected ${req.method} ${req.url.split("?")[0]}: role ${route.role} required`);
    return reply.status(403).send({ error: "forbidden", message: `role ${route.role} required` });
  }

  const limitKey = user ? `u:${user.id}` : `ip:${req.ip}`;
  if (!allow(limitKey)) {
    rateLimited.add(1, { route: route.prefix });
    logger.warn({ requestId: req.id, key: limitKey, route: route.prefix, event: "gateway.rate_limited" }, `rate limit exceeded for ${limitKey} on ${route.prefix}`);
    return reply.status(429).header("retry-after", "60").send({ error: "rate_limited", message: "too many requests" });
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || k.startsWith("x-user-") || v === undefined) continue;
    if (k === "authorization" && route.auth !== "none") continue; // services trust x-user-* instead
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["x-request-id"] = req.id;
  headers["x-forwarded-for"] = req.ip;
  if (user) {
    headers["x-user-id"] = user.id;
    headers["x-user-email"] = user.email;
    headers["x-user-roles"] = user.roles.join(",");
  }
  // Also on the incoming request (client copies were dropped above), so the gateway's own
  // request log line can name the user.
  for (const h of ["x-user-id", "x-user-email", "x-user-roles"]) delete req.headers[h];
  if (user) Object.assign(req.headers, { "x-user-id": user.id, "x-user-email": user.email, "x-user-roles": user.roles.join(",") });
  Object.assign(headers, route.headers);

  const target = new URL(req.url.slice((route.strip ?? route.prefix).length) || "/", route.upstream);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as Buffer | undefined);
  let res: Response;
  try {
    res = await fetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    const timeout = e.name === "TimeoutError";
    upstreamErrors.add(1, { route: route.prefix, reason: timeout ? "timeout" : "unreachable" });
    logger.error({ requestId: req.id, upstream: route.upstream, err: e.message }, `${route.prefix} upstream ${route.upstream} ${timeout ? "timed out" : "unreachable"}: ${e.message}`);
    return reply.status(timeout ? 504 : 502).send({ error: timeout ? "upstream_timeout" : "bad_gateway", message: `${route.prefix} unavailable` });
  }
  reply.status(res.status);
  for (const h of PASS_BACK) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  return reply.send(Buffer.from(await res.arrayBuffer()));
});

start(app, PORT).catch((err) => {
  logger.fatal({ err }, "api-gateway failed to start");
  process.exit(1);
});
