/**
 * order: checkout and order history. Coordinates the checkout saga.
 *
 * POST /orders (checkout)
 *   1. read the cart                       (sync -> cart)
 *   2. create order + outbox order.placed  (one DB transaction)
 *   3. reserve stock                       (sync -> inventory)      409 => cancelled
 *   4. start payment                       (sync -> payment -> external provider)
 *   5. clear the cart
 * Later, asynchronously (Kafka):
 *   payment.succeeded -> confirmed + order.confirmed
 *   payment.failed    -> cancelled + order.cancelled  (inventory releases the stock)
 * A sweeper cancels orders whose payment never completes.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Topics } from "@shop/contracts";
import type { OrderItem } from "@shop/contracts";
import {
  createServer, createPool, migrate, start, withTx, enqueue, startOutboxRelay, createKafka, connectProducer, runConsumer, callService,
  forwardHeaders, requireUser, HttpError, logger, metrics, trace, every, quietly, env, envNumber,
} from "@shop/telemetry";
import type { PoolClient } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const CART_URL = env("CART_URL", "http://cart:8080");
const INVENTORY_URL = env("INVENTORY_URL", "http://inventory:8080");
const PAYMENT_URL = env("PAYMENT_URL", "http://payment:8080");
const PAYMENT_TIMEOUT_SECONDS = envNumber("ORDER_PAYMENT_TIMEOUT_SECONDS", 600);

const pool = createPool();
const tracer = trace.getTracer("order");
const meter = metrics.getMeter("order");
const checkouts = meter.createCounter("shop_checkouts_total", { description: "Checkout attempts by outcome" });
const ordersFinal = meter.createCounter("shop_orders_completed_total", { description: "Orders reaching a final status" });
const orderValue = meter.createHistogram("shop_order_value_cents", { description: "Order total", unit: "cents" });
const checkoutDuration = meter.createHistogram("shop_checkout_duration_ms", { description: "Synchronous checkout duration", unit: "ms" });

interface OrderRow {
  id: string;
  user_id: string;
  user_email: string;
  status: string;
  total_cents: number;
  items: OrderItem[];
  payment_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toOrder = (r: OrderRow) => ({
  id: r.id,
  status: r.status,
  totalCents: r.total_cents,
  items: r.items,
  paymentId: r.payment_id,
  failureReason: r.failure_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const event = () => ({ eventId: randomUUID(), occurredAt: new Date().toISOString() });

/** Move an open order to `cancelled` and emit order.cancelled. Returns false if it was already final. */
async function cancelOrder(c: PoolClient, orderId: string, reason: string): Promise<boolean> {
  const { rows } = await c.query<OrderRow>(
    `UPDATE orders SET status = 'cancelled', failure_reason = $2, updated_at = now()
     WHERE id = $1 AND status IN ('created', 'awaiting_payment') RETURNING *`,
    [orderId, reason],
  );
  const o = rows[0];
  if (!o) return false;
  await enqueue(c, Topics.OrderCancelled, o.id, {
    ...event(),
    type: Topics.OrderCancelled,
    orderId: o.id,
    userId: o.user_id,
    userEmail: o.user_email,
    reason,
  });
  ordersFinal.add(1, { status: "cancelled", reason: reason.split(":")[0] });
  return true;
}

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

app.post("/orders", async (req, reply) => {
  const started = Date.now();
  const user = requireUser(req);
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
  const span = trace.getActiveSpan();
  const finish = (outcome: string) => {
    checkouts.add(1, { outcome });
    checkoutDuration.record(Date.now() - started, { outcome });
    span?.setAttribute("checkout.outcome", outcome);
  };

  if (idempotencyKey) {
    const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2", [user.id, idempotencyKey]);
    if (rows[0]) {
      logger.info({ orderId: rows[0].id, idempotencyKey }, `duplicate checkout request (idempotency key ${idempotencyKey}), returning existing order ${rows[0].id.slice(0, 8)}`);
      return reply.status(200).send(toOrder(rows[0]));
    }
  }

  // 1. cart
  const cart = await callService(CART_URL, "/cart", { headers: forwardHeaders(req) });
  if (cart.status !== 200) throw new HttpError(502, `cart returned ${cart.status}`, "cart_error");
  const items: OrderItem[] = cart.data.items.map((i: any) => ({
    productId: i.productId,
    name: i.name,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
  }));
  if (items.length === 0) {
    finish("cart_empty");
    throw new HttpError(400, "cart is empty", "cart_empty");
  }
  const totalCents = items.reduce((n, i) => n + i.quantity * i.unitPriceCents, 0);
  const orderId = randomUUID();
  span?.setAttributes({ "order.id": orderId, "order.total_cents": totalCents, "order.items": items.length });

  // 2. order + order.placed (same transaction)
  await withTx(pool, async (c) => {
    await c.query(
      "INSERT INTO orders (id, user_id, user_email, status, total_cents, items, idempotency_key) VALUES ($1, $2, $3, 'created', $4, $5, $6)",
      [orderId, user.id, user.email, totalCents, JSON.stringify(items), idempotencyKey],
    );
    await enqueue(c, Topics.OrderPlaced, orderId, {
      ...event(),
      type: Topics.OrderPlaced,
      orderId,
      userId: user.id,
      userEmail: user.email,
      totalCents,
      items,
    });
  });
  logger.info({ orderId, userId: user.id, totalCents, items: items.length }, `order ${orderId.slice(0, 8)} created for ${user.email.split("@")[0]}: ${items.length} ${items.length === 1 ? "item" : "items"}, $${(totalCents / 100).toFixed(2)}`);

  // 3. reserve stock
  const reservation = await callService(INVENTORY_URL, "/reservations", {
    method: "POST",
    body: { orderId, items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
  }).catch((err: HttpError) => ({ status: err.statusCode, data: { error: err.code, message: err.message } }));
  if (reservation.status !== 200 && reservation.status !== 201) {
    const reason = reservation.status === 409 ? "out_of_stock" : "inventory_unavailable";
    await withTx(pool, (c) => cancelOrder(c, orderId, `${reason}: ${reservation.data?.message ?? reservation.status}`));
    logger.warn({ orderId, reason, detail: reservation.data?.message }, `checkout of order ${orderId.slice(0, 8)} failed: could not reserve stock (${reservation.data?.message ?? reason})`);
    finish(reason);
    throw new HttpError(reservation.status === 409 ? 409 : 503, reservation.data?.message ?? "inventory unavailable", reason);
  }

  // 4. payment
  const payment = await callService(PAYMENT_URL, "/payments", {
    method: "POST",
    body: { orderId, userId: user.id, amountCents: totalCents },
    timeoutMs: 12_000,
  }).catch((err: HttpError) => ({ status: err.statusCode, data: { error: err.code, message: err.message } }));
  if (payment.status !== 200 && payment.status !== 201) {
    await withTx(pool, (c) => cancelOrder(c, orderId, `payment_unavailable: ${payment.data?.message ?? payment.status}`));
    logger.error({ orderId, status: payment.status, detail: payment.data }, `checkout of order ${orderId.slice(0, 8)} failed: payment service returned HTTP ${payment.status}`);
    finish("payment_unavailable");
    throw new HttpError(503, "payment service unavailable, order cancelled", "payment_unavailable");
  }
  await pool.query(
    `UPDATE orders SET payment_id = $2, updated_at = now(),
       status = CASE WHEN status = 'created' THEN 'awaiting_payment' ELSE status END
     WHERE id = $1`,
    [orderId, payment.data.id],
  );

  // 5. clear cart (best effort: the order exists either way)
  await callService(CART_URL, "/cart", { method: "DELETE", headers: forwardHeaders(req) }).catch((err) =>
    logger.warn({ orderId, err: (err as Error).message }, `could not clear cart after order ${orderId.slice(0, 8)}: ${(err as Error).message}`),
  );

  orderValue.record(totalCents);
  finish(payment.data.status === "failed" ? "payment_declined" : "accepted");
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [orderId]);
  return reply.status(201).send(toOrder(rows[0]));
});

app.get("/orders", async (req) => {
  const user = requireUser(req);
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [user.id]);
  return { items: rows.map(toOrder) };
});

app.get("/orders/:id", async (req) => {
  const user = requireUser(req);
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]);
  if (!rows[0] || (rows[0].user_id !== user.id && !user.roles.includes("instructor"))) {
    throw new HttpError(404, "order not found", "order_not_found");
  }
  return toOrder(rows[0]);
});

async function onPaymentEvent(topic: string, e: any) {
  trace.getActiveSpan()?.setAttributes({ "order.id": e.orderId, "payment.id": e.paymentId });
  if (topic === Topics.PaymentSucceeded) {
    const changed = await withTx(pool, async (c) => {
      const { rows } = await c.query<OrderRow>(
        `UPDATE orders SET status = 'confirmed', payment_id = $2, updated_at = now()
         WHERE id = $1 AND status IN ('created', 'awaiting_payment') RETURNING *`,
        [e.orderId, e.paymentId],
      );
      const o = rows[0];
      if (!o) return false;
      await enqueue(c, Topics.OrderConfirmed, o.id, {
        ...event(),
        type: Topics.OrderConfirmed,
        orderId: o.id,
        userId: o.user_id,
        userEmail: o.user_email,
        paymentId: e.paymentId,
        totalCents: o.total_cents,
      });
      return true;
    });
    if (changed) {
      ordersFinal.add(1, { status: "confirmed", reason: "paid" });
      logger.info({ orderId: e.orderId, paymentId: e.paymentId }, `order ${e.orderId.slice(0, 8)} confirmed: payment ${e.paymentId.slice(0, 8)} succeeded`);
    } else {
      const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [e.orderId]);
      const level = rows[0]?.status === "cancelled" ? "error" : "info";
      logger[level]({ orderId: e.orderId, currentStatus: rows[0]?.status }, "payment succeeded for an order that is not open (ignored)");
    }
    return;
  }
  const changed = await withTx(pool, (c) => cancelOrder(c, e.orderId, `payment_failed: ${e.reason}`));
  logger[changed ? "warn" : "info"]({ orderId: e.orderId, reason: e.reason }, changed ? "order cancelled: payment failed" : "payment failure ignored, order not open");
}

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  const kafka = createKafka("order");
  const producer = await connectProducer(kafka);
  const stopRelay = startOutboxRelay(pool, producer);
  const consumer = await runConsumer({
    kafka,
    groupId: "order",
    topics: [Topics.PaymentSucceeded, Topics.PaymentFailed],
    handler: onPaymentEvent,
  });

  const stopSweeper = every("payment timeout sweeper", 60_000, async () => {
    const stale = await quietly(async () =>
      (
        await pool.query<{ id: string }>(
          "SELECT id FROM orders WHERE status IN ('created', 'awaiting_payment') AND created_at < now() - make_interval(secs => $1) LIMIT 100",
          [PAYMENT_TIMEOUT_SECONDS],
        )
      ).rows,
    );
    for (const { id } of stale) {
      await tracer.startActiveSpan("order.payment_timeout", { attributes: { "order.id": id } }, async (span) => {
        try {
          if (await withTx(pool, (c) => cancelOrder(c, id, "payment_timeout"))) {
            logger.warn({ orderId: id, timeoutSeconds: PAYMENT_TIMEOUT_SECONDS }, `order ${id.slice(0, 8)} cancelled: no payment result after ${PAYMENT_TIMEOUT_SECONDS} s`);
          }
        } finally {
          span.end();
        }
      });
    }
  });

  await start(app, PORT, [stopSweeper, stopRelay, () => consumer.disconnect(), () => producer.disconnect(), () => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "order failed to start");
  process.exit(1);
});
