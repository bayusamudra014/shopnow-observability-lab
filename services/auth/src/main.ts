/**
 * auth-service: a deliberately small OAuth 2.0-style token service.
 *
 *   POST /register               self-service sign-up (returns tokens)
 *   POST /oauth/token            grant_type=password | refresh_token
 *   POST /oauth/revoke           revoke a refresh token
 *   GET  /userinfo               claims of the bearer token
 *   GET  /.well-known/jwks.json  public keys the api-gateway uses to verify JWTs
 *   GET  /.well-known/openid-configuration
 *
 * Access tokens are RS256 JWTs. Refresh tokens are opaque, stored as sha256 hashes, and
 * rotated on every use. Passwords are bcrypt hashes; bcrypt is intentionally slow, which
 * shows up clearly in traces under load (see the "bcrypt.compare" span).
 */
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, createLocalJWKSet, SignJWT } from "jose";
import type { JWK, KeyLike } from "jose";
import { z } from "zod";
import { createServer, createPool, migrate, start, HttpError, logger, metrics, trace, env, envNumber } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const ISSUER = env("JWT_ISSUER", "http://shop.local/api/auth");
const AUDIENCE = env("JWT_AUDIENCE", "shop-api");
const ACCESS_TTL = envNumber("ACCESS_TOKEN_TTL_SECONDS", 900);
const REFRESH_TTL = envNumber("REFRESH_TOKEN_TTL_SECONDS", 7 * 24 * 3600);
const BCRYPT_COST = envNumber("BCRYPT_COST", 10);

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);

const pool = createPool();
const tracer = trace.getTracer("auth");
const meter = metrics.getMeter("auth");
const logins = meter.createCounter("shop_auth_logins_total", { description: "Login attempts by result" });
const tokens = meter.createCounter("shop_auth_tokens_issued_total", { description: "Tokens issued by grant type" });
const registrations = meter.createCounter("shop_auth_registrations_total", { description: "Sign-ups by result" });

interface Key {
  kid: string;
  privateKey: KeyLike;
  jwk: JWK;
}
let keys: Key[] = [];

async function loadKeys(): Promise<void> {
  let { rows } = await pool.query("SELECT kid, private_pem, public_pem FROM signing_keys ORDER BY created_at DESC");
  if (rows.length === 0) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    await pool.query("INSERT INTO signing_keys (kid, private_pem, public_pem) VALUES ($1, $2, $3)", [
      randomUUID(),
      await exportPKCS8(privateKey),
      await exportSPKI(publicKey),
    ]);
    logger.info("generated new RSA signing key");
    ({ rows } = await pool.query("SELECT kid, private_pem, public_pem FROM signing_keys ORDER BY created_at DESC"));
  }
  keys = await Promise.all(
    rows.map(async (r) => {
      const jwk = await exportJWK(await importSPKI(r.public_pem, "RS256"));
      return { kid: r.kid, privateKey: await importPKCS8(r.private_pem, "RS256"), jwk: { ...jwk, kid: r.kid, alg: "RS256", use: "sig" } };
    }),
  );
}

async function seedUsers(): Promise<void> {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM users");
  if (Number(rows[0].n) > 0) return;
  const count = envNumber("SEED_USER_COUNT", 100);
  const shopperHash = await bcrypt.hash(env("SEED_USER_PASSWORD"), BCRYPT_COST);
  const instructorHash = await bcrypt.hash(env("INSTRUCTOR_PASSWORD"), BCRYPT_COST);
  for (let i = 1; i <= count; i++) {
    const username = `shopper${String(i).padStart(3, "0")}`;
    await pool.query(
      "INSERT INTO users (username, email, name, password_hash, roles) VALUES ($1, $2, $3, $4, '{customer}') ON CONFLICT DO NOTHING",
      [username, `${username}@shop.local`, `Shopper ${String(i).padStart(3, "0")}`, shopperHash],
    );
  }
  await pool.query(
    "INSERT INTO users (username, email, name, password_hash, roles) VALUES ('instructor', 'instructor@shop.local', 'Instructor', $1, '{customer,instructor}') ON CONFLICT DO NOTHING",
    [instructorHash],
  );
  logger.info({ shoppers: count }, `seeded ${count} shopper accounts`);
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  name: string;
  password_hash: string;
  roles: string[];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function issueTokens(user: UserRow, clientId: string | undefined, grant: string) {
  const key = keys[0];
  const accessToken = await new SignJWT({ email: user.email, name: user.name, roles: user.roles, preferred_username: user.username })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .setJti(randomUUID())
    .sign(key.privateKey);
  const refreshToken = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO refresh_tokens (token_hash, user_id, client_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
    [sha256(refreshToken), user.id, clientId ?? null, REFRESH_TTL],
  );
  tokens.add(1, { grant_type: grant });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
    scope: "openid profile email",
  };
}

const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("password"), username: z.string().min(1), password: z.string().min(1), client_id: z.string().optional() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().min(1), client_id: z.string().optional() }),
]);

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

// OAuth clients usually send form-encoded bodies; accept both that and JSON.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body as string)));
});

const RegisterRequest = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "username must be at least 3 characters")
    .max(32, "username must be at most 32 characters")
    .regex(/^[a-z0-9._-]+$/, "username may only contain letters, digits, '.', '_' and '-'"),
  email: z.string().trim().toLowerCase().email("email address is not valid").max(254),
  name: z.string().trim().min(1, "name is required").max(100),
  password: z.string().min(8, "password must be at least 8 characters").max(128),
  client_id: z.string().optional(),
});

/** Self-service sign-up. Creates a customer account and signs it in (returns tokens). */
app.post("/register", async (req, reply) => {
  const parsed = RegisterRequest.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    registrations.add(1, { result: "invalid" });
    return reply.status(400).send({ error: "invalid_request", message });
  }
  const body = parsed.data;
  const hash = await tracer.startActiveSpan("bcrypt.hash", { attributes: { "bcrypt.cost": BCRYPT_COST } }, async (span) => {
    try {
      return await bcrypt.hash(body.password, BCRYPT_COST);
    } finally {
      span.end();
    }
  });
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (username, email, name, password_hash, roles) VALUES ($1, $2, $3, $4, '{customer}')
     ON CONFLICT DO NOTHING RETURNING *`,
    [body.username, body.email, body.name, hash],
  );
  if (rows.length === 0) {
    const { rows: taken } = await pool.query<{ username: string }>("SELECT username FROM users WHERE username = $1 OR email = $2", [body.username, body.email]);
    const field = taken.some((t) => t.username === body.username) ? "username" : "email";
    registrations.add(1, { result: "conflict" });
    logger.warn({ username: body.username, field, event: "auth.register_conflict" }, `registration rejected: ${field} already taken (${field === "username" ? body.username : body.email})`);
    return reply.status(409).send({ error: `${field}_taken`, message: `that ${field} is already registered` });
  }
  const user = rows[0];
  trace.getActiveSpan()?.setAttribute("enduser.id", user.id);
  registrations.add(1, { result: "created" });
  logger.info({ userId: user.id, username: user.username, clientId: body.client_id, event: "auth.registered" }, `new account registered: ${user.username} <${user.email}>`);
  return reply.status(201).send(await issueTokens(user, body.client_id, "register"));
});

app.post("/oauth/token", async (req, reply) => {
  const parsed = TokenRequest.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_request", error_description: "unsupported grant_type or missing fields" });
  }
  const body = parsed.data;
  const span = trace.getActiveSpan();
  span?.setAttribute("oauth.grant_type", body.grant_type);
  if (body.client_id) span?.setAttribute("oauth.client_id", body.client_id);

  if (body.grant_type === "password") {
    const login = body.username.toLowerCase();
    const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE username = $1 OR email = $1", [login]);
    const user = rows[0];
    // Always run bcrypt, even for unknown users, so response time does not reveal which usernames exist.
    const ok = await tracer.startActiveSpan("bcrypt.compare", { attributes: { "bcrypt.cost": BCRYPT_COST } }, async (s) => {
      try {
        return await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
      } finally {
        s.end();
      }
    });
    if (!user || !ok) {
      logins.add(1, { result: "invalid_credentials", client_id: body.client_id ?? "unknown" });
      logger.warn({ username: login, clientId: body.client_id, ip: req.ip, event: "auth.login_failed" }, `login failed for ${login}: invalid credentials${body.client_id ? ` (client ${body.client_id})` : ""} from ${req.ip}`);
      return reply.status(401).send({ error: "invalid_grant", error_description: "invalid username or password" });
    }
    span?.setAttribute("enduser.id", user.id);
    logins.add(1, { result: "success", client_id: body.client_id ?? "unknown" });
    logger.info({ userId: user.id, username: user.username, clientId: body.client_id, event: "auth.login_succeeded" }, `login succeeded: ${user.username} via ${body.client_id}`);
    return issueTokens(user, body.client_id, "password");
  }

  // refresh_token grant with rotation
  const hash = sha256(body.refresh_token);
  const { rows } = await pool.query("SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1", [hash]);
  const rt = rows[0];
  if (!rt) {
    logger.warn({ event: "auth.refresh_unknown" }, "refresh failed: unknown or expired refresh token");
    return reply.status(400).send({ error: "invalid_grant", error_description: "unknown refresh token" });
  }
  if (rt.revoked_at) {
    // A rotated token being used again may mean it was stolen: revoke every token of that user.
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [rt.user_id]);
    logger.warn({ userId: rt.user_id, event: "auth.refresh_reuse_detected" }, `refresh token reuse detected for user ${rt.user_id}: all sessions revoked`);
    return reply.status(400).send({ error: "invalid_grant", error_description: "refresh token already used" });
  }
  if (new Date(rt.expires_at) < new Date()) {
    return reply.status(400).send({ error: "invalid_grant", error_description: "refresh token expired" });
  }
  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [hash]);
  const user = (await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [rt.user_id])).rows[0];
  span?.setAttribute("enduser.id", user.id);
  return issueTokens(user, body.client_id, "refresh_token");
});

app.post("/oauth/revoke", async (req) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(token)]);
  return { revoked: true };
});

app.get("/userinfo", async (req) => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "missing bearer token", "invalid_token");
  try {
    const { payload } = await jwtVerify(auth.slice(7), createLocalJWKSet({ keys: keys.map((k) => k.jwk) }), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return { sub: payload.sub, email: payload.email, name: payload.name, preferred_username: payload.preferred_username, roles: payload.roles };
  } catch (err) {
    throw new HttpError(401, (err as Error).message, "invalid_token");
  }
});

app.get("/.well-known/jwks.json", async (_req, reply) => {
  reply.header("cache-control", "public, max-age=300");
  return { keys: keys.map((k) => k.jwk) };
});

app.get("/.well-known/openid-configuration", async () => ({
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  grant_types_supported: ["password", "refresh_token"],
  id_token_signing_alg_values_supported: ["RS256"],
}));

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  await loadKeys();
  await seedUsers();
  await start(app, PORT, [() => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "auth-service failed to start");
  process.exit(1);
});
