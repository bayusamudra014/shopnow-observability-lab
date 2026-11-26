/**
 * payment: talks to the EXTERNAL payment provider.
 *
 *  POST /payments                      start a payment for an order (called by order)
 *  POST /webhooks/payment-provider     async result from the provider (exposed on hooks.local)
 *  GET  /payments/:id                  debugging
 *
 * The provider answers "pending" and reports the final result later with a signed webhook.
 * The webhook is a NEW request with no trace context, so it starts a new trace. We store
 * the checkout's trace context with the payment and add a span LINK back to it.
 *
 * Failure handling you can observe:
 *  - HMAC signature check (401 + security log on mismatch)
 *  - duplicate webhooks ignored via webhook_events (idempotency)
 *  - reconciler polls the provider for payments whose webhook never arrived
 *  - a charge that succeeds AFTER we gave up (timeout) is refunded automatically
 */
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Topics } from "@shop/contracts";
import {
  createServer, createPool, migrate, start, withTx, enqueue, startOutboxRelay, createKafka, connectProducer, HttpError, logger, metrics,
  trace, propagation, context, every, quietly, env, envNumber,
} from "@shop/telemetry";
import type { Pool } from "@shop/telemetry";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { Link } from "@opentelemetry/api";
import { createCharge, findChargeByReference, getCharge, refundCharge } from "./provider-client.js";
import type { Charge } from "./provider-client.js";

const PORT = envNumber("PORT", 8080);
const WEBHOOK_SECRET = env("PROVIDER_WEBHOOK_SECRET");
const WEBHOOK_TOLERANCE_SECONDS = envNumber("WEBHOOK_TOLERANCE_SECONDS", 300);
const RECONCILE_AFTER_SECONDS = envNumber("RECONCILE_AFTER_SECONDS", 60);
const RECONCILE_INTERVAL_MS = envNumber("RECONCILE_INTERVAL_MS", 30_000);

const pool: Pool = createPool();
const tracer = trace.getTracer("payment");
const meter = metrics.getMeter("payment");
const paymentsCounter = meter.createCounter("shop_payments_total", { description: "Payments reaching a final status, by status and source" });
const webhooks = meter.createCounter("shop_payment_webhooks_total", { description: "Webhooks received by result" });
const doubleCharges = meter.createCounter("shop_payment_late_success_refunds_total", {
  description: "Charges that succeeded after the payment was already failed, refunded automatically",
});

interface PaymentRow {
  id: string;
  order_id: string;
  user_id: string;
  amount_cents: number;
  status: string;
  provider_charge_id: string | null;
  failure_reason: string | null;
  trace_context: Record<string, string>;
  resolved_by: string | null;
  created_at: Date;
}

const toPayment = (p: PaymentRow) => ({
  id: p.id,
  orderId: p.order_id,
  amountCents: p.amount_cents,
  status: p.status,
  providerChargeId: p.provider_charge_id,
  failureReason: p.failure_reason,
  resolvedBy: p.resolved_by,
  createdAt: p.created_at,
});

const linkTo = (p: PaymentRow): Link[] => {
  const sc = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, p.trace_context));
  return sc ? [{ context: sc, attributes: { "link.reason": "checkout that created this payment" } }] : [];
};

type Outcome = "applied" | "duplicate" | "refunded";

/** Move a pending payment to its final status and emit the Kafka event (outbox). */
async function resolvePayment(
  paymentId: string,
  to: "succeeded" | "failed",
  source: "create" | "webhook" | "reconciler",
  opts: { chargeId?: string; reason?: string } = {},
): Promise<Outcome> {
  const applied = await withTx(pool, async (c) => {
    const { rows } = await c.query<PaymentRow>(
      `UPDATE payments SET status = $2, failure_reason = $3, resolved_by = $4, provider_charge_id = COALESCE(provider_charge_id, $5), updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [paymentId, to, opts.reason ?? null, source, opts.chargeId ?? null],
    );
    const p = rows[0];
    if (!p) return false;
    const base = { eventId: randomUUID(), occurredAt: new Date().toISOString(), paymentId: p.id, orderId: p.order_id, amountCents: p.amount_cents };
    if (to === "succeeded") {
      await enqueue(c, Topics.PaymentSucceeded, p.order_id, { ...base, type: Topics.PaymentSucceeded, providerChargeId: p.provider_charge_id });
    } else {
      await enqueue(c, Topics.PaymentFailed, p.order_id, { ...base, type: Topics.PaymentFailed, reason: opts.reason ?? "unknown" });
    }
    return true;
  });
  if (applied) {
    paymentsCounter.add(1, { status: to, source });
    logger[to === "succeeded" ? "info" : "warn"]({ paymentId, source, reason: opts.reason }, `payment ${paymentId.slice(0, 8)} ${to} (via ${source})${opts.reason ? `: ${opts.reason}` : ""}`);
    return "applied";
  }

  const { rows } = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  const current = rows[0];
  if (current?.status === "failed" && to === "succeeded" && opts.chargeId) {
    // We told the order it failed (e.g. provider timeout) but the provider charged the customer anyway.
    logger.error(
      { paymentId, chargeId: opts.chargeId, previousReason: current.failure_reason, event: "payment.late_success" },
      `charge ${opts.chargeId} succeeded after payment ${paymentId.slice(0, 8)} was marked failed (${current.failure_reason}): refunding customer`,
    );
    try {
      await refundCharge(opts.chargeId, "payment already failed in merchant system");
      await pool.query("UPDATE payments SET status = 'refunded', provider_charge_id = $2, updated_at = now() WHERE id = $1", [paymentId, opts.chargeId]);
      doubleCharges.add(1);
    } catch (err) {
      logger.error({ paymentId, chargeId: opts.chargeId, err }, `automatic refund of charge ${opts.chargeId} failed, manual action required: ${(err as Error).message}`);
    }
    return "refunded";
  }
  logger.info({ paymentId, currentStatus: current?.status, attempted: to, source }, `payment ${paymentId.slice(0, 8)} already ${current?.status}, ignoring ${to} from ${source}`);
  return "duplicate";
}

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

// Keep the raw body: the webhook signature is computed over the exact bytes received.
const rawBodies = new WeakMap<object, string>();
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  rawBodies.set(req, body as string);
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});

app.post("/payments", async (req, reply) => {
  const body = z.object({ orderId: z.string().uuid(), userId: z.string(), amountCents: z.number().int().positive() }).parse(req.body);
  const span = trace.getActiveSpan();
  span?.setAttributes({ "order.id": body.orderId, "payment.amount_cents": body.amountCents });

  const existing = await pool.query<PaymentRow>("SELECT * FROM payments WHERE order_id = $1", [body.orderId]);
  if (existing.rows[0]) return reply.status(200).send(toPayment(existing.rows[0]));

  const id = randomUUID();
  span?.setAttribute("payment.id", id);
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await pool.query("INSERT INTO payments (id, order_id, user_id, amount_cents, status, trace_context) VALUES ($1, $2, $3, $4, 'pending', $5)", [
    id,
    body.orderId,
    body.userId,
    body.amountCents,
    JSON.stringify(carrier),
  ]);

  try {
    const res = await createCharge(id, body.amountCents, body.orderId);
    if (res.status === 200 || res.status === 201 || res.status === 202) {
      const charge = res.data;
      span?.setAttribute("payment.provider_charge_id", charge.id);
      await pool.query("UPDATE payments SET provider_charge_id = $2, updated_at = now() WHERE id = $1", [id, charge.id]);
      logger.info({ paymentId: id, chargeId: charge.id, providerStatus: charge.status }, `charge ${charge.id} created at provider for payment ${id.slice(0, 8)}: ${charge.status}`);
      if (charge.status === "succeeded") await resolvePayment(id, "succeeded", "create", { chargeId: charge.id });
      if (charge.status === "failed") await resolvePayment(id, "failed", "create", { chargeId: charge.id, reason: `declined: ${charge.failureCode}` });
    } else if (res.status === 402) {
      const charge = res.data.charge;
      await resolvePayment(id, "failed", "create", { chargeId: charge?.id, reason: `declined: ${charge?.failureCode ?? res.data.error}` });
    } else {
      // 4xx other than 402 means WE sent something wrong (bad API key, bad payload).
      logger.error({ paymentId: id, status: res.status, body: res.data }, `provider rejected charge for payment ${id.slice(0, 8)} with HTTP ${res.status}`);
      await resolvePayment(id, "failed", "create", { reason: `provider_rejected_${res.status}` });
    }
  } catch (err) {
    const e = err as HttpError;
    logger.error({ paymentId: id, err: e.message, code: e.code }, `provider unavailable, payment ${id.slice(0, 8)} failed: ${e.message}`);
    await resolvePayment(id, "failed", "create", { reason: `provider_unavailable: ${e.code ?? "error"}` });
  }

  const { rows } = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  return reply.status(201).send(toPayment(rows[0]));
});

app.get("/payments/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { rows } = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  if (!rows[0]) throw new HttpError(404, "payment not found", "payment_not_found");
  return toPayment(rows[0]);
});

function verifySignature(header: string | undefined, raw: string): string | null {
  if (!header) return "missing signature header";
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return "malformed signature header";
  if (Math.abs(Date.now() / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) return "timestamp outside tolerance (replay?)";
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b) ? null : "signature mismatch";
}

const WebhookEvent = z.object({
  id: z.string(),
  type: z.enum(["charge.succeeded", "charge.failed"]),
  data: z.object({
    charge: z.object({ id: z.string(), status: z.string(), merchantReference: z.string(), amountCents: z.number(), failureCode: z.string().optional() }),
  }),
});

app.post("/webhooks/payment-provider", async (req, reply) => {
  const span = trace.getActiveSpan();
  const problem = verifySignature(req.headers["x-provider-signature"] as string | undefined, rawBodies.get(req) ?? "");
  if (problem) {
    webhooks.add(1, { result: "bad_signature" });
    span?.setAttribute("webhook.rejected_reason", problem);
    logger.warn({ reason: problem, ip: req.ip, event: "payment.webhook_signature_invalid" }, `webhook rejected: invalid signature (${problem}) from ${req.ip}`);
    return reply.status(401).send({ error: "invalid_signature", message: problem });
  }
  const evt = WebhookEvent.parse(req.body);
  const charge = evt.data.charge;
  span?.setAttributes({ "webhook.event_id": evt.id, "webhook.type": evt.type, "payment.provider_charge_id": charge.id, "payment.id": charge.merchantReference });

  const fresh = await pool.query("INSERT INTO webhook_events (event_id, charge_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
    evt.id,
    charge.id,
    evt.type,
  ]);
  if (fresh.rowCount === 0) {
    webhooks.add(1, { result: "duplicate" });
    logger.info({ eventId: evt.id, chargeId: charge.id }, `duplicate webhook ${evt.id} for charge ${charge.id} ignored`);
    return { received: true, duplicate: true };
  }

  const { rows } = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [charge.merchantReference]);
  const payment = rows[0];
  if (!payment) {
    webhooks.add(1, { result: "unknown_payment" });
    logger.error({ eventId: evt.id, chargeId: charge.id, merchantReference: charge.merchantReference }, `webhook for unknown payment: charge ${charge.id}, reference ${charge.merchantReference}`);
    return reply.status(404).send({ error: "unknown_payment" });
  }

  const outcome = await tracer.startActiveSpan(
    "payment.webhook.process",
    { links: linkTo(payment), attributes: { "payment.id": payment.id, "order.id": payment.order_id } },
    async (s) => {
      try {
        return evt.type === "charge.succeeded"
          ? await resolvePayment(payment.id, "succeeded", "webhook", { chargeId: charge.id })
          : await resolvePayment(payment.id, "failed", "webhook", { chargeId: charge.id, reason: `declined: ${charge.failureCode ?? "unknown"}` });
      } finally {
        s.end();
      }
    },
  );
  webhooks.add(1, { result: outcome });
  return { received: true };
});

async function reconcile() {
  const stale = await quietly(async () =>
    (
      await pool.query<PaymentRow>(
        "SELECT * FROM payments WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 50",
        [RECONCILE_AFTER_SECONDS],
      )
    ).rows,
  );
  for (const p of stale) {
    await tracer.startActiveSpan("payment.reconcile", { links: linkTo(p), attributes: { "payment.id": p.id, "order.id": p.order_id } }, async (span) => {
      try {
        let charge: Charge | undefined;
        if (p.provider_charge_id) {
          const res = await getCharge(p.provider_charge_id);
          if (res.status === 200) charge = res.data;
        } else {
          const res = await findChargeByReference(p.id);
          charge = res.data.items?.[0];
        }
        if (!charge) {
          const ageMinutes = (Date.now() - new Date(p.created_at).getTime()) / 60_000;
          if (ageMinutes > 5) await resolvePayment(p.id, "failed", "reconciler", { reason: "charge_not_found" });
          return;
        }
        span.setAttribute("payment.provider_status", charge.status);
        if (charge.status === "pending") return;
        logger.warn({ paymentId: p.id, chargeId: charge.id, providerStatus: charge.status, event: "payment.reconciled" }, `payment ${p.id.slice(0, 8)} resolved by reconciler as ${charge.status} (webhook never arrived)`);
        await resolvePayment(p.id, charge.status === "succeeded" ? "succeeded" : "failed", "reconciler", {
          chargeId: charge.id,
          reason: charge.status === "failed" ? `declined: ${charge.failureCode ?? "unknown"}` : undefined,
        });
      } catch (err) {
        logger.warn({ paymentId: p.id, err: (err as Error).message }, `reconcile of payment ${p.id.slice(0, 8)} failed: ${(err as Error).message}`);
      } finally {
        span.end();
      }
    });
  }
}

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  const kafka = createKafka("payment");
  const producer = await connectProducer(kafka);
  const stopRelay = startOutboxRelay(pool, producer);
  const stopReconciler = every("reconciler", RECONCILE_INTERVAL_MS, reconcile);
  await start(app, PORT, [stopReconciler, stopRelay, () => producer.disconnect(), () => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "payment failed to start");
  process.exit(1);
});
