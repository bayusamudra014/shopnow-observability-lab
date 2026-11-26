/**
 * Targets: the shop deployments this generator drives (for example the instructor's own
 * minikube plus every student's server). Each target has its own base URL, its own pool
 * of seeded users (the seed password differs per deployment) and, optionally, the admin
 * API of its payment provider for incident drills.
 *
 * Targets are stored in TARGETS_FILE (a Docker volume) so changes made in the web UI
 * survive restarts. On first start a "local" target is created from the environment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { logger, env, envNumber } from "@shop/telemetry";
import { record, routeOf } from "./stats.js";

const TARGETS_FILE = env("TARGETS_FILE", "/data/targets.json");
const REQUEST_TIMEOUT_MS = envNumber("REQUEST_TIMEOUT_MS", 20_000);

export const TargetSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "lowercase letters, digits and dashes"),
  /** e.g. http://shop.local/api */
  baseUrl: z.string().url(),
  /** Optional IP to connect to instead of resolving the hostname (keeps Host: shop.local for the ingress). */
  resolveTo: z.string().ip({ version: "v4" }).optional().or(z.literal("").transform(() => undefined)),
  enabled: z.boolean().default(true),
  /** Multiplies the global journey rate for this target. */
  rateMultiplier: z.number().min(0).max(20).default(1),
  seedUserPrefix: z.string().default("shopper"),
  seedUserCount: z.number().int().min(1).max(1000).default(100),
  seedUserPassword: z.string().min(1),
  providerAdminUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  providerAdminToken: z.string().optional(),
});
export type TargetConfig = z.infer<typeof TargetSchema>;

/** The journey currently running (set by the engine), used for stats and request headers. */
export const journeyScope = new AsyncLocalStorage<{ journey: string; userAgent: string; clientIp: string }>();

/**
 * Simulated client addresses, sent as X-Forwarded-For like a CDN or load balancer in front
 * of the shop would. Customers come from many consumer-ISP addresses; a botnet from a few.
 * The shop only sees them if its ingress is configured to trust X-Forwarded-For.
 */
const CUSTOMER_PREFIXES = ["36.68", "36.72", "103.47", "110.136", "114.124", "125.160", "180.244", "182.1", "202.67", "223.255"];
const BOTNET = ["45.155.205.233", "45.155.205.241", "185.220.101.47", "185.220.101.52", "194.26.29.113", "91.240.118.172"];
const octet = () => 1 + Math.floor(Math.random() * 254);
export const randomCustomerIp = () => `${CUSTOMER_PREFIXES[Math.floor(Math.random() * CUSTOMER_PREFIXES.length)]}.${octet()}.${octet()}`;
export const randomBotIp = () => BOTNET[Math.floor(Math.random() * BOTNET.length)];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36",
];
/** A browser user-agent; one per journey, like one visitor using one device. */
export const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
/** Credential-stuffing tools mostly pretend to be a browser; some do not bother. */
const BOT_AGENTS = [...USER_AGENTS, "python-requests/2.32.4", "okhttp/4.12.0", "Go-http-client/1.1"];
export const randomBotUserAgent = () => BOT_AGENTS[Math.floor(Math.random() * BOT_AGENTS.length)];

export interface ApiResult<T = any> {
  status: number;
  data: T;
  requestId?: string;
}

export class ApiClient {
  constructor(
    readonly target: Target,
    readonly token?: string,
  ) {}

  withToken(token: string | undefined) {
    return new ApiClient(this.target, token);
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    // Generated traffic is NOT labelled: no journey/synthetic headers, and an ordinary browser
    // user-agent, so in the shop's telemetry it looks like real customers. The journey is
    // only known here, for the generator's own dashboard.
    const scope = journeyScope.getStore();
    const journey = scope?.journey;
    const h: Record<string, string> = { accept: "application/json", "user-agent": scope?.userAgent ?? randomUserAgent(), ...headers };
    if (scope?.clientIp) h["x-forwarded-for"] = scope.clientIp;
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (body !== undefined) h["content-type"] = "application/json";
    const started = Date.now();
    const route = routeOf(path);
    const base = { at: started, target: this.target.config.name, method, path, route, journey };
    try {
      const res = await undiciFetch(`${this.target.base}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        dispatcher: this.target.dispatcher,
      });
      const text = await res.text();
      const requestId = res.headers.get("x-request-id") ?? undefined;
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = { raw: text.slice(0, 200) };
      }
      const ms = Date.now() - started;
      record({ ...base, status: res.status, ms, requestId, error: res.status >= 400 ? (data?.message ?? data?.error) : undefined });
      return { status: res.status, data, requestId };
    } catch (err) {
      const e = err as Error & { cause?: Error };
      const message = e.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : (e.cause?.message ?? e.message);
      record({ ...base, status: "error", ms: Date.now() - started, error: message });
      throw new Error(`${method} ${route}: ${message}`);
    }
  }

  get = <T = any>(path: string) => this.request<T>("GET", path);
  post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => this.request<T>("POST", path, body, headers);
  patch = <T = any>(path: string, body?: unknown) => this.request<T>("PATCH", path, body);
  delete = <T = any>(path: string) => this.request<T>("DELETE", path);
}

export interface Session {
  username: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  leased: boolean;
}

export class LoginError extends Error {}

export class Target {
  config!: TargetConfig;
  base = "";
  dispatcher?: Agent;
  sessions: Session[] = [];
  anonymous!: ApiClient;
  /** Journeys started per tick are accumulated here by the engine. */
  carry = 0;

  constructor(config: TargetConfig) {
    this.apply(config);
  }

  apply(config: TargetConfig) {
    const usersChanged =
      !this.config ||
      this.config.seedUserPrefix !== config.seedUserPrefix ||
      this.config.seedUserCount !== config.seedUserCount ||
      this.config.seedUserPassword !== config.seedUserPassword ||
      this.config.baseUrl !== config.baseUrl;
    this.config = config;
    this.base = config.baseUrl.replace(/\/$/, "");
    void this.dispatcher?.close();
    const ip = config.resolveTo;
    this.dispatcher = ip
      ? new Agent({
          connect: {
            // Connect to `ip` but keep the URL's hostname for the Host header / ingress routing.
            lookup: (_host: string, opts: { all?: boolean }, cb: (...args: any[]) => void) =>
              opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4),
          },
        })
      : undefined;
    if (usersChanged) {
      this.sessions = Array.from({ length: config.seedUserCount }, (_, i) => ({
        username: `${config.seedUserPrefix}${String(i + 1).padStart(3, "0")}`,
        expiresAt: 0,
        leased: false,
      }));
    }
    this.anonymous = new ApiClient(this);
  }

  /** Take a free user so each journey has its own cart; share one when all are busy. */
  leaseUser(): Session {
    const free = this.sessions.filter((s) => !s.leased);
    const s = free.length ? free[Math.floor(Math.random() * free.length)] : this.sessions[Math.floor(Math.random() * this.sessions.length)];
    s.leased = true;
    return s;
  }

  releaseUser(s: Session) {
    s.leased = false;
  }

  randomUsername() {
    return this.sessions[Math.floor(Math.random() * this.sessions.length)].username;
  }

  private async tokenRequest(body: Record<string, string>) {
    const res = await this.anonymous.post("/auth/oauth/token", { ...body, client_id: "traffic-generator" });
    if (res.status !== 200) throw new LoginError(`token endpoint returned ${res.status}: ${res.data?.error_description ?? res.data?.error ?? ""}`);
    return res.data as { access_token: string; refresh_token: string; expires_in: number };
  }

  /** Client authenticated as `s`: cached token, refresh, or a fresh password login. */
  async authenticate(s: Session, forceLogin = false): Promise<ApiClient> {
    if (!forceLogin && s.accessToken && s.expiresAt - Date.now() > 30_000) return new ApiClient(this, s.accessToken);
    let tokens;
    if (!forceLogin && s.refreshToken) {
      tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: s.refreshToken }).catch(() => undefined);
    }
    tokens ??= await this.tokenRequest({ grant_type: "password", username: s.username, password: this.config.seedUserPassword });
    s.accessToken = tokens.access_token;
    s.refreshToken = tokens.refresh_token;
    s.expiresAt = Date.now() + tokens.expires_in * 1000;
    return new ApiClient(this, s.accessToken);
  }

  /** Config safe to show in the UI (secrets masked). */
  view() {
    const { seedUserPassword, providerAdminToken, ...rest } = this.config;
    return {
      ...rest,
      seedUserPasswordSet: Boolean(seedUserPassword),
      providerAdminTokenSet: Boolean(providerAdminToken),
      usersLeased: this.sessions.filter((s) => s.leased).length,
    };
  }
}

// ---- registry + persistence --------------------------------------------------------------

export const targets = new Map<string, Target>();

function defaultsFromEnv(): TargetConfig[] {
  // Several targets at once (e.g. one per student VM): comma-separated API base URLs that
  // share the seed password and payment-provider admin. Each is named after its first host label.
  const urls = (process.env.TARGET_BASE_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (urls.length > 0) {
    return urls.map((baseUrl) =>
      TargetSchema.parse({
        name: new URL(baseUrl).hostname.split(".")[0],
        baseUrl,
        seedUserPrefix: env("SEED_USER_PREFIX", "shopper"),
        seedUserCount: envNumber("SEED_USER_COUNT", 100),
        seedUserPassword: env("SEED_USER_PASSWORD"),
        providerAdminUrl: process.env.PROVIDER_ADMIN_URL || undefined,
        providerAdminToken: process.env.PROVIDER_ADMIN_TOKEN || undefined,
      }),
    );
  }
  return [
    TargetSchema.parse({
      name: env("DEFAULT_TARGET_NAME", "local"),
      baseUrl: env("TARGET_BASE_URL", "http://shop.local/api"),
      resolveTo: process.env.TARGET_RESOLVE_TO || undefined,
      seedUserPrefix: env("SEED_USER_PREFIX", "shopper"),
      seedUserCount: envNumber("SEED_USER_COUNT", 100),
      seedUserPassword: env("SEED_USER_PASSWORD"),
      providerAdminUrl: process.env.PROVIDER_ADMIN_URL || undefined,
      providerAdminToken: process.env.PROVIDER_ADMIN_TOKEN || undefined,
    }),
  ];
}

export function loadTargets() {
  let configs: TargetConfig[];
  if (existsSync(TARGETS_FILE)) {
    configs = z.array(TargetSchema).parse(JSON.parse(readFileSync(TARGETS_FILE, "utf8")));
    logger.info({ file: TARGETS_FILE, count: configs.length }, "loaded targets");
  } else {
    configs = defaultsFromEnv();
    logger.info({ file: TARGETS_FILE }, "no targets file yet, created the default target from the environment");
  }
  for (const c of configs) targets.set(c.name, new Target(c));
  saveTargets();
}

export function saveTargets() {
  try {
    mkdirSync(path.dirname(TARGETS_FILE), { recursive: true });
    writeFileSync(TARGETS_FILE, JSON.stringify([...targets.values()].map((t) => t.config), null, 2));
  } catch (err) {
    logger.warn({ err: (err as Error).message, file: TARGETS_FILE }, "could not save targets (they will not survive a restart)");
  }
}

export function upsertTarget(input: unknown, existingName?: string): Target {
  const previous = existingName ? targets.get(existingName) : undefined;
  const raw = input as Record<string, unknown>;
  // Empty secret fields in an edit mean "keep the current value".
  const merged = previous
    ? {
        ...previous.config,
        ...raw,
        seedUserPassword: raw.seedUserPassword || previous.config.seedUserPassword,
        providerAdminToken: raw.providerAdminToken || previous.config.providerAdminToken,
      }
    : raw;
  const config = TargetSchema.parse(merged);
  if (existingName && existingName !== config.name) targets.delete(existingName);
  const t = targets.get(config.name) ?? previous;
  if (t) t.apply(config);
  const target = t ?? new Target(config);
  targets.set(config.name, target);
  saveTargets();
  logger.info({ target: config.name, baseUrl: config.baseUrl, enabled: config.enabled }, previous ? "target updated" : "target added");
  return target;
}

export function removeTarget(name: string) {
  const t = targets.get(name);
  if (!t) return false;
  void t.dispatcher?.close();
  targets.delete(name);
  saveTargets();
  logger.info({ target: name }, "target removed");
  return true;
}
