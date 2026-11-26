import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { ZodError } from "zod";
import { logger } from "./logger.js";

/** Throw this from a route handler to return a specific HTTP status. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, message: string, code = "error") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface User {
  id: string;
  email: string;
  roles: string[];
}

const errorReasons = new WeakMap<FastifyRequest, string>();

/** Read the identity the api-gateway put on the request (after verifying the JWT). */
export function currentUser(req: FastifyRequest): User | undefined {
  const id = req.headers["x-user-id"];
  if (typeof id !== "string" || !id) return undefined;
  const roles = String(req.headers["x-user-roles"] ?? "");
  return { id, email: String(req.headers["x-user-email"] ?? ""), roles: roles ? roles.split(",") : [] };
}

export function requireUser(req: FastifyRequest): User {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "authentication required", "unauthenticated");
  return user;
}

/** Headers to forward when one service calls another on behalf of a user. */
export function forwardHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of ["x-user-id", "x-user-email", "x-user-roles", "x-request-id"]) {
    const v = req.headers[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
}

export interface ServerOptions {
  /** Extra readiness check (e.g. DB ping). Throw to report not-ready. */
  ready?: () => Promise<void>;
  bodyLimit?: number;
  /** Log every request (default true). Errors are always logged. */
  requestLogging?: boolean;
}

const quiet = new Set(["/health", "/ready"]);

/** Fastify server with the conventions every service shares. */
export function createServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimit ?? 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // Give the HTTP server span a low-cardinality name like "GET /products/:id".
    const span = trace.getActiveSpan();
    const route = req.routeOptions.url;
    if (span && route) {
      span.updateName(`${req.method} ${route}`);
      span.setAttribute("http.route", route);
    }
    const user = currentUser(req);
    if (span && user) span.setAttribute("enduser.id", user.id);
    if (span) span.setAttribute("request.id", req.id);
  });

  // Remember why a request failed, so the request log line can say it.
  app.addHook("onSend", async (req, reply, payload) => {
    // Proxied responses (api-gateway) arrive as a Buffer, the rest as a string.
    const text = typeof payload === "string" ? payload : Buffer.isBuffer(payload) && payload.length < 8192 ? payload.toString("utf8") : "";
    if (reply.statusCode >= 400 && text.startsWith("{")) {
      try {
        const body = JSON.parse(text) as { error?: string; message?: string; error_description?: string };
        errorReasons.set(req, body.message ?? body.error_description ?? body.error ?? "");
      } catch {
        /* not JSON */
      }
    }
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? req.url;
    if (quiet.has(route)) return;
    const status = reply.statusCode;
    const durationMs = Math.round(reply.elapsedTime);
    const user = currentUser(req);
    const reason = errorReasons.get(req);
    const fields = {
      requestId: req.id,
      method: req.method,
      route,
      url: req.url,
      statusCode: status,
      durationMs,
      userId: user?.id,
      userEmail: user?.email || undefined,
      reason: reason || undefined,
    };
    // e.g.  GET /orders/2310d616-… → 404 Not Found in 3 ms · order not found · shopper015
    const who = user?.email ? ` · ${user.email.split("@")[0]}` : "";
    const msg = `${req.method} ${req.url.split("?")[0]} → ${status} ${STATUS_CODES[status] ?? ""} in ${durationMs} ms${reason ? ` · ${reason}` : ""}${who}`;
    if (status >= 500) logger.error(fields, msg);
    else if (opts.requestLogging === false) return;
    else if (status >= 400) logger.warn(fields, msg);
    else logger.info(fields, msg);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const span = trace.getActiveSpan();
    if (err instanceof ZodError) {
      const summary = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      logger.warn({ requestId: req.id, issues: err.issues }, `validation failed on ${req.method} ${req.routeOptions.url ?? req.url}: ${summary}`);
      return reply.status(400).send({ error: "validation_error", message: "invalid request", issues: err.issues });
    }
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) {
      span?.recordException(err);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ err, requestId: req.id, route: req.routeOptions.url }, `${req.method} ${req.routeOptions.url ?? req.url} failed: ${err.message}`);
    }
    const code = err instanceof HttpError ? err.code : status >= 500 ? "internal_error" : (err.code ?? "error");
    return reply.status(status).send({ error: code, message: status >= 500 && !(err instanceof HttpError) ? "internal server error" : err.message });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    try {
      await opts.ready?.();
      return { status: "ready" };
    } catch (err) {
      return reply.status(503).send({ status: "not_ready", reason: (err as Error).message });
    }
  });

  return app;
}

type Closer = () => Promise<unknown> | unknown;

/** Listen, and on SIGTERM/SIGINT close the server, run closers, and flush telemetry. */
export async function start(app: FastifyInstance, port: number, closers: Closer[] = []): Promise<void> {
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, `service started on port ${port}`);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, `shutting down (${signal})`);
    try {
      await app.close();
      for (const c of closers) await c();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    }
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

export async function shutdownTelemetry(): Promise<void> {
  const sdk = (globalThis as { __shopOtelSdk?: NodeSDK }).__shopOtelSdk;
  await sdk?.shutdown().catch(() => undefined);
}
