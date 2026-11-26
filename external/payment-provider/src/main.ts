/**
 * Mock EXTERNAL payment provider (think Stripe / Midtrans / Xendit).
 *
 * It is "someone else's system": it runs outside the cluster in its own Docker Compose
 * project, has its own database, and sends NO telemetry to our SigNoz. The shop can only
 * observe it from the outside (client spans, status codes, webhooks).
 *
 *   POST /v1/charges              create a charge (Bearer API key, Idempotency-Key)
 *   GET  /v1/charges/:id          look up a charge
 *   GET  /v1/charges?merchantReference=...
 *   POST /v1/refunds              refund a charge
 *   webhook -> charge.webhookUrl  charge.succeeded / charge.failed, HMAC-SHA256 signed
 *              (the URL the merchant sent with the charge, else WEBHOOK_URL)
 *
 *   GET  /admin                   chaos control page
 *   GET|PUT /admin/chaos, POST /admin/chaos/reset, GET /admin/stats   (Bearer admin token)
 *   GET|POST /admin/tokens, DELETE /admin/tokens/:id                   generate / revoke admin tokens
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createServer, createPool, migrate, start, logger, sleep, env, envNumber } from "@shop/telemetry";
import { chaos, ChaosSchema, defaults, roll } from "./chaos.js";

const PORT = envNumber("PORT", 8080);
const API_KEY = env("PROVIDER_API_KEY");
/** Optional: tokens can also be generated in the console. */
const ADMIN_TOKEN = process.env.PROVIDER_ADMIN_TOKEN ?? "";
const WEBHOOK_URL = env("WEBHOOK_URL", "http://hooks.local/webhooks/payment-provider");
const WEBHOOK_SECRET = env("PROVIDER_WEBHOOK_SECRET");
/**
 * Hosts a merchant may ask webhooks to be sent to, as comma-separated suffixes
 * (e.g. ".example.com"). Empty = any host. Keeps a public MockPay from
 * being used to make requests to arbitrary addresses.
 */
const WEBHOOK_ALLOWED_HOSTS = (process.env.WEBHOOK_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const webhookHostAllowed = (url: string) => {
  const host = new URL(url).hostname.toLowerCase();
  return WEBHOOK_ALLOWED_HOSTS.length === 0 || WEBHOOK_ALLOWED_HOSTS.some((s) => host === s.replace(/^\./, "") || host.endsWith(s.startsWith(".") ? s : `.${s}`));
};

const pool = createPool();
const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

interface ChargeRow {
  id: string;
  merchant_reference: string;
  amount_cents: number;
  currency: string;
  description: string | null;
  status: string;
  failure_code: string | null;
  webhook_url: string | null;
  created_at: Date;
  updated_at: Date;
}

const toCharge = (c: ChargeRow) => ({
  id: c.id,
  object: "charge",
  status: c.status,
  amountCents: c.amount_cents,
  currency: c.currency,
  merchantReference: c.merchant_reference,
  description: c.description,
  failureCode: c.failure_code ?? undefined,
  webhookUrl: c.webhook_url ?? undefined,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(token: string, what: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7), token)) {
      logger.warn({ ip: req.ip, url: req.url }, `rejected request with invalid ${what}`);
      return reply.status(401).send({ error: "unauthorized", message: `invalid ${what}` });
    }
  };
}

// ---- admin tokens ------------------------------------------------------------------------
// Accepted admin credentials: PROVIDER_ADMIN_TOKEN from the environment (if set) and any
// non-revoked token generated in the console (stored as a sha256 hash).

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const generateToken = () => `mpa_${randomBytes(24).toString("base64url")}`;

async function createAdminToken(name: string) {
  const token = generateToken();
  const id = newId("tok");
  await pool.query("INSERT INTO admin_tokens (id, name, token_hash, token_hint) VALUES ($1, $2, $3, $4)", [id, name, sha256(token), token.slice(-4)]);
  logger.warn({ tokenId: id, name }, "admin token generated");
  return { id, name, token };
}

async function adminAuth(req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization ?? "";
  const presented = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (presented && ADMIN_TOKEN && safeEqual(presented, ADMIN_TOKEN)) return;
  if (presented) {
    const { rows } = await pool.query("UPDATE admin_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id", [sha256(presented)]);
    if (rows[0]) return;
  }
  logger.warn({ ip: req.ip, url: req.url }, "rejected request with invalid admin token");
  return reply.status(401).send({ error: "unauthorized", message: "invalid admin token" });
}

// ---- webhooks --------------------------------------------------------------------------

function sign(body: string, secret: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function recordDelivery(eventId: string, chargeId: string, type: string, attempt: number, statusCode: number | null, error: string | null, note?: string) {
  await pool
    .query("INSERT INTO webhook_deliveries (event_id, charge_id, type, attempt, status_code, error, note) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      eventId, chargeId, type, attempt, statusCode, error, note ?? null,
    ])
    .catch((err) => logger.error({ err }, "could not record webhook delivery"));
}

/** Deliver an event at least once, retrying with backoff. Chaos may drop/duplicate/corrupt it. */
async function deliverWebhook(charge: ChargeRow) {
  const type = charge.status === "succeeded" ? "charge.succeeded" : "charge.failed";
  const event = { id: newId("evt"), object: "event", type, createdAt: new Date().toISOString(), data: { charge: toCharge(charge) } };
  const body = JSON.stringify(event);

  if (roll(chaos.dropWebhookRate)) {
    logger.warn({ eventId: event.id, chargeId: charge.id, type }, "chaos: webhook dropped, never delivered");
    await recordDelivery(event.id, charge.id, type, 0, null, null, "dropped by chaos");
    return;
  }
  const url = charge.webhook_url || WEBHOOK_URL;
  if (!url) {
    logger.warn({ eventId: event.id, chargeId: charge.id }, `webhook for charge ${charge.id} not sent: no webhookUrl on the charge and WEBHOOK_URL is empty`);
    await recordDelivery(event.id, charge.id, type, 0, null, null, "no webhook URL");
    return;
  }
  const badSignature = roll(chaos.badSignatureRate);
  const copies = roll(chaos.duplicateWebhookRate) ? 2 : 1;

  for (let copy = 1; copy <= copies; copy++) {
    for (let attempt = 1; attempt <= chaos.webhookMaxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "MockPay-Webhooks/1.0",
            "x-provider-signature": sign(body, badSignature ? "wrong-secret" : WEBHOOK_SECRET),
            "x-provider-event-id": event.id,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await recordDelivery(event.id, charge.id, type, attempt, res.status, null, [badSignature && "bad signature", copy > 1 && "duplicate"].filter(Boolean).join(", ") || undefined);
        if (res.ok) {
          logger.info({ eventId: event.id, chargeId: charge.id, type, attempt, copy }, "webhook delivered");
          break;
        }
        logger.warn({ eventId: event.id, chargeId: charge.id, status: res.status, attempt }, "webhook rejected by merchant");
        if (res.status === 401 && badSignature) break; // retrying with the same bad signature is pointless
      } catch (err) {
        await recordDelivery(event.id, charge.id, type, attempt, null, (err as Error).message);
        logger.warn({ eventId: event.id, chargeId: charge.id, attempt, err: (err as Error).message }, "webhook delivery failed");
      }
      if (attempt === chaos.webhookMaxAttempts) logger.error({ eventId: event.id, chargeId: charge.id }, "webhook gave up after max attempts");
      else await sleep(1000 * 2 ** (attempt - 1));
    }
    if (copy < copies) await sleep(500);
  }
}

/** Decide the final outcome of a pending charge after the webhook delay, then notify. */
function scheduleSettlement(chargeId: string, delayMs = chaos.webhookDelayMs + Math.random() * 1000) {
  setTimeout(async () => {
    try {
      const failed = roll(chaos.asyncDeclineRate);
      const { rows } = await pool.query<ChargeRow>(
        "UPDATE charges SET status = $2, failure_code = $3, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
        [chargeId, failed ? "failed" : "succeeded", failed ? "insufficient_funds" : null],
      );
      if (rows[0]) {
        logger.info({ chargeId, status: rows[0].status }, "charge settled");
        await deliverWebhook(rows[0]);
      }
    } catch (err) {
      logger.error({ err, chargeId }, "settlement failed");
    }
  }, delayMs);
}

// ---- API -------------------------------------------------------------------------------

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

app.register(async (api) => {
  api.addHook("onRequest", bearer(API_KEY, "API key"));
  api.addHook("onRequest", async () => {
    const delay = chaos.latencyMs + Math.random() * chaos.latencyJitterMs;
    if (delay > 0) await sleep(delay);
  });

  api.post("/v1/charges", async (req, reply) => {
    const body = z
      .object({ amountCents: z.number().int().positive(), currency: z.string().length(3), merchantReference: z.string().min(1), description: z.string().optional(), webhookUrl: z.string().url().max(500).optional() })
      .parse(req.body);
    if (body.webhookUrl && !/^https?:/.test(body.webhookUrl)) return reply.status(400).send({ error: "invalid_webhook_url", message: "webhookUrl must be http(s)" });
    if (body.webhookUrl && !webhookHostAllowed(body.webhookUrl)) {
      logger.warn({ webhookUrl: body.webhookUrl }, `charge rejected: webhook host not allowed (${new URL(body.webhookUrl).hostname})`);
      return reply.status(400).send({ error: "webhook_host_not_allowed", message: `webhook host must end with one of: ${WEBHOOK_ALLOWED_HOSTS.join(", ")}` });
    }
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;

    if (key) {
      const { rows } = await pool.query<ChargeRow>("SELECT * FROM charges WHERE idempotency_key = $1", [key]);
      if (rows[0]) {
        logger.info({ chargeId: rows[0].id, idempotencyKey: key }, "idempotent replay, returning existing charge");
        return reply.status(rows[0].status === "failed" ? 402 : 200).send(rows[0].status === "failed" ? { error: rows[0].failure_code, charge: toCharge(rows[0]) } : toCharge(rows[0]));
      }
    }

    if (roll(chaos.errorRate)) {
      const status = Math.random() < 0.5 ? 500 : 503;
      logger.error({ merchantReference: body.merchantReference, status }, "chaos: internal error");
      return reply.status(status).send({ error: "provider_error", message: "something went wrong on our side" });
    }

    const declined = roll(chaos.declineRate);
    const { rows } = await pool.query<ChargeRow>(
      `INSERT INTO charges (id, idempotency_key, merchant_reference, amount_cents, currency, description, status, failure_code, webhook_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [newId("ch"), key, body.merchantReference, body.amountCents, body.currency, body.description ?? null, declined ? "failed" : "pending", declined ? "card_declined" : null, body.webhookUrl ?? null],
    );
    const charge = rows[0];

    if (declined) {
      logger.info({ chargeId: charge.id, merchantReference: body.merchantReference }, "charge declined");
      void deliverWebhook(charge);
      return reply.status(402).send({ error: "card_declined", charge: toCharge(charge) });
    }

    scheduleSettlement(charge.id);
    if (roll(chaos.timeoutRate)) {
      logger.warn({ chargeId: charge.id, hangMs: chaos.hangMs }, "chaos: charge created, now hanging");
      await sleep(chaos.hangMs);
    }
    logger.info({ chargeId: charge.id, merchantReference: body.merchantReference, amountCents: body.amountCents }, "charge created (pending)");
    return reply.status(201).send(toCharge(charge));
  });

  api.get("/v1/charges/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { rows } = await pool.query<ChargeRow>("SELECT * FROM charges WHERE id = $1", [id]);
    if (!rows[0]) return reply.status(404).send({ error: "not_found", message: "no such charge" });
    return toCharge(rows[0]);
  });

  api.get("/v1/charges", async (req) => {
    const { merchantReference } = z.object({ merchantReference: z.string() }).parse(req.query);
    const { rows } = await pool.query<ChargeRow>("SELECT * FROM charges WHERE merchant_reference = $1 ORDER BY created_at DESC", [merchantReference]);
    return { items: rows.map(toCharge) };
  });

  api.post("/v1/refunds", async (req, reply) => {
    const body = z.object({ chargeId: z.string(), reason: z.string().optional() }).parse(req.body);
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
    if (key) {
      const { rows } = await pool.query("SELECT * FROM refunds WHERE idempotency_key = $1", [key]);
      if (rows[0]) return { id: rows[0].id, chargeId: rows[0].charge_id, status: "succeeded" };
    }
    const { rows } = await pool.query<ChargeRow>("UPDATE charges SET status = 'refunded', updated_at = now() WHERE id = $1 AND status = 'succeeded' RETURNING *", [body.chargeId]);
    if (!rows[0]) return reply.status(409).send({ error: "not_refundable", message: "charge does not exist or did not succeed" });
    const id = newId("re");
    await pool.query("INSERT INTO refunds (id, charge_id, idempotency_key, reason) VALUES ($1, $2, $3, $4)", [id, body.chargeId, key, body.reason ?? null]);
    logger.info({ refundId: id, chargeId: body.chargeId, reason: body.reason }, "charge refunded");
    return reply.status(201).send({ id, chargeId: body.chargeId, status: "succeeded" });
  });
});

// ---- admin / chaos ---------------------------------------------------------------------

app.get("/admin", async (_req, reply) => {
  reply.type("text/html").send(await readFile(path.join(__dirname, "../public/admin.html"), "utf8"));
});

app.register(async (admin) => {
  admin.addHook("onRequest", adminAuth);

  admin.get("/admin/tokens", async () => {
    const { rows } = await pool.query(
      "SELECT id, name, token_hint, created_at, last_used_at, revoked_at FROM admin_tokens ORDER BY created_at DESC",
    );
    return { environmentTokenConfigured: Boolean(ADMIN_TOKEN), items: rows };
  });
  admin.post("/admin/tokens", async (req, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    // The plain token is returned ONLY in this response.
    return reply.status(201).send(await createAdminToken(name));
  });
  admin.delete("/admin/tokens/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { rowCount } = await pool.query("UPDATE admin_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
    if (!rowCount) return reply.status(404).send({ error: "not_found", message: "no active token with that id" });
    logger.warn({ tokenId: id }, "admin token revoked");
    return { revoked: id };
  });

  admin.get("/admin/chaos", async () => chaos);
  admin.get("/admin/chaos/defaults", async () => defaults());
  admin.put("/admin/chaos", async (req) => {
    const patch = ChaosSchema.partial().parse(req.body);
    Object.assign(chaos, patch);
    logger.warn({ chaos }, "chaos settings changed");
    return chaos;
  });
  admin.post("/admin/chaos/reset", async () => {
    Object.assign(chaos, defaults());
    logger.warn({ chaos }, "chaos settings reset to defaults");
    return chaos;
  });
  admin.get("/admin/stats", async () => {
    const [byStatus, perMinute, deliveryResults, charges, deliveries] = await Promise.all([
      pool.query("SELECT status, count(*)::int AS count FROM charges WHERE created_at > now() - interval '15 minutes' GROUP BY status ORDER BY status"),
      pool.query(
        `SELECT date_trunc('minute', created_at) AS minute, count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('succeeded','refunded'))::int AS succeeded,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM charges WHERE created_at > now() - interval '15 minutes' GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT CASE WHEN note LIKE 'dropped%' THEN 'dropped' WHEN status_code BETWEEN 200 AND 299 THEN 'delivered'
                     WHEN status_code IS NULL THEN 'network_error' ELSE 'http_' || status_code END AS result, count(*)::int AS count
         FROM webhook_deliveries WHERE created_at > now() - interval '15 minutes' GROUP BY 1 ORDER BY 2 DESC`,
      ),
      pool.query("SELECT id, merchant_reference, amount_cents, status, failure_code, created_at, updated_at FROM charges ORDER BY created_at DESC LIMIT 20"),
      pool.query("SELECT event_id, charge_id, type, attempt, status_code, error, note, created_at FROM webhook_deliveries ORDER BY id DESC LIMIT 20"),
    ]);
    return {
      chargesByStatus: byStatus.rows,
      chargesPerMinute: perMinute.rows,
      webhookResults: deliveryResults.rows,
      recentCharges: charges.rows,
      recentWebhookDeliveries: deliveries.rows,
    };
  });
});

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  // No token configured anywhere: generate one so the console is usable, and print it once.
  if (!ADMIN_TOKEN) {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_tokens WHERE revoked_at IS NULL");
    if (rows[0].n === 0) {
      const { token } = await createAdminToken("bootstrap");
      console.log(`\n  MockPay admin token (shown once, store it safely):\n    ${token}\n  Console: http://localhost:8090/admin\n`);
    }
  }
  // Charges left pending by a restart still get settled (and their webhooks sent).
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM charges WHERE status = 'pending'");
  for (const r of rows) scheduleSettlement(r.id, 3000 + Math.random() * 5000);
  if (rows.length) logger.info({ count: rows.length }, "re-scheduled pending charges after restart");
  logger.info({ chaos, webhookUrl: WEBHOOK_URL, webhookAllowedHosts: WEBHOOK_ALLOWED_HOSTS }, `payment provider configuration: default webhook ${WEBHOOK_URL}, allowed webhook hosts ${WEBHOOK_ALLOWED_HOSTS.join(", ") || "any"}`);
  await start(app, PORT, [() => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "payment provider failed to start");
  process.exit(1);
});
