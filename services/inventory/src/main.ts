/**
 * inventory: stock levels and reservations.
 *
 *  POST /reservations   reserve stock for an order (synchronous call from order)
 *  GET  /stock, /stock/:productId
 *  Kafka: order.confirmed -> commit reservation, order.cancelled -> release it
 *
 * Reservations lock stock rows (SELECT ... FOR UPDATE). Under the flash-sale profile many
 * orders compete for the same few products, which shows up as lock waits in the traces.
 * A "supplier" restocks low products every minute so the shop never runs dry for good.
 */
import path from "node:path";
import { z } from "zod";
import { Topics } from "@shop/contracts";
import {
  createServer, createPool, migrate, start, withTx, HttpError, logger, metrics, trace, createKafka, runConsumer, every, quietly, envNumber,
} from "@shop/telemetry";
import type { PoolClient } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const RESTOCK_THRESHOLD = envNumber("RESTOCK_THRESHOLD", 10);
const RESTOCK_AMOUNT = envNumber("RESTOCK_AMOUNT", 100);
const RESTOCK_INTERVAL_MS = envNumber("RESTOCK_INTERVAL_MS", 60_000);

const pool = createPool();
const tracer = trace.getTracer("inventory");
const meter = metrics.getMeter("inventory");
const reservationsCounter = meter.createCounter("shop_inventory_reservations_total", { description: "Reservation attempts by result" });
const transitions = meter.createCounter("shop_inventory_reservation_transitions_total", { description: "Reservations committed/released" });
const restocks = meter.createCounter("shop_inventory_restocks_total", { description: "Supplier restocks" });
let lastStock = new Map<string, number>();
meter
  .createObservableGauge("shop_inventory_available_units", { description: "Units available per product" })
  .addCallback((obs) => {
    for (const [productId, available] of lastStock) obs.observe(available, { product_id: productId });
  });

const ReserveBody = z.object({
  orderId: z.string().uuid(),
  items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive().max(100) })).min(1),
});

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

app.get("/stock", async (req) => {
  const { ids } = z.object({ ids: z.string().optional() }).parse(req.query);
  const { rows } = ids
    ? await pool.query("SELECT product_id, available FROM stock WHERE product_id = ANY($1) ORDER BY product_id", [ids.split(",")])
    : await pool.query("SELECT product_id, available FROM stock ORDER BY product_id");
  return { items: rows.map((r) => ({ productId: r.product_id, available: r.available })) };
});

app.get("/stock/:productId", async (req) => {
  const { productId } = z.object({ productId: z.string() }).parse(req.params);
  const { rows } = await pool.query("SELECT product_id, available FROM stock WHERE product_id = $1", [productId]);
  if (!rows[0]) throw new HttpError(404, `no stock record for ${productId}`, "product_not_found");
  return { productId, available: rows[0].available };
});

app.post("/reservations", async (req, reply) => {
  const body = ReserveBody.parse(req.body);
  const span = trace.getActiveSpan();
  span?.setAttributes({ "order.id": body.orderId, "reservation.items": body.items.length });

  const result = await withTx(pool, async (c) => {
    const existing = await c.query("SELECT product_id, quantity, status FROM reservations WHERE order_id = $1", [body.orderId]);
    if (existing.rows.length > 0) return { idempotent: true, rows: existing.rows };

    // Lock rows in a fixed order to avoid deadlocks between concurrent orders.
    const items = [...body.items].sort((a, b) => a.productId.localeCompare(b.productId));
    const { rows: stock } = await c.query<{ product_id: string; available: number }>(
      "SELECT product_id, available FROM stock WHERE product_id = ANY($1) ORDER BY product_id FOR UPDATE",
      [items.map((i) => i.productId)],
    );
    const available = new Map(stock.map((s) => [s.product_id, s.available]));
    for (const item of items) {
      const have = available.get(item.productId);
      if (have === undefined) throw new HttpError(404, `unknown product ${item.productId}`, "product_not_found");
      if (have < item.quantity) {
        throw new HttpError(409, `insufficient stock for ${item.productId}: requested ${item.quantity}, available ${have}`, "out_of_stock");
      }
    }
    for (const item of items) {
      await c.query("UPDATE stock SET available = available - $2, reserved = reserved + $2, updated_at = now() WHERE product_id = $1", [
        item.productId,
        item.quantity,
      ]);
      await c.query("INSERT INTO reservations (order_id, product_id, quantity) VALUES ($1, $2, $3)", [body.orderId, item.productId, item.quantity]);
    }
    return { idempotent: false, rows: items };
  }).catch((err) => {
    if (err instanceof HttpError) {
      reservationsCounter.add(1, { result: err.code });
      logger.warn({ orderId: body.orderId, reason: err.message }, `stock reservation for order ${body.orderId.slice(0, 8)} rejected: ${err.message}`);
    }
    throw err;
  });

  reservationsCounter.add(1, { result: result.idempotent ? "duplicate" : "reserved" });
  logger.info({ orderId: body.orderId, items: body.items, idempotent: result.idempotent }, `reserved stock for order ${body.orderId.slice(0, 8)}: ${body.items.map((i) => `${i.quantity} × ${i.productId}`).join(", ")}${result.idempotent ? " (repeat request, already reserved)" : ""}`);
  return reply.status(result.idempotent ? 200 : 201).send({ orderId: body.orderId, status: "reserved" });
});

async function finishReservation(c: PoolClient, orderId: string, to: "committed" | "released") {
  const { rows } = await c.query<{ product_id: string; quantity: number }>(
    "UPDATE reservations SET status = $2, updated_at = now() WHERE order_id = $1 AND status = 'reserved' RETURNING product_id, quantity",
    [orderId, to],
  );
  for (const r of rows) {
    const sql =
      to === "committed"
        ? "UPDATE stock SET reserved = reserved - $2, updated_at = now() WHERE product_id = $1"
        : "UPDATE stock SET reserved = reserved - $2, available = available + $2, updated_at = now() WHERE product_id = $1";
    await c.query(sql, [r.product_id, r.quantity]);
  }
  return rows.length;
}

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));

  const kafka = createKafka("inventory");
  const consumer = await runConsumer({
    kafka,
    groupId: "inventory",
    topics: [Topics.OrderConfirmed, Topics.OrderCancelled],
    handler: async (topic, event) => {
      const to = topic === Topics.OrderConfirmed ? "committed" : "released";
      trace.getActiveSpan()?.setAttribute("order.id", event.orderId);
      const n = await withTx(pool, (c) => finishReservation(c, event.orderId, to));
      if (n === 0) {
        logger.info({ orderId: event.orderId, topic }, `${topic}: no open reservation for order ${event.orderId.slice(0, 8)} (already processed or never reserved)`);
        return;
      }
      transitions.add(n, { to });
      logger.info({ orderId: event.orderId, lines: n }, `reservation for order ${event.orderId.slice(0, 8)} ${to} (${n} product lines) after ${topic}`);
    },
  });

  const stopRestock = every("restock", RESTOCK_INTERVAL_MS, async () => {
    const low = await quietly(async () => {
      const { rows } = await pool.query<{ product_id: string; available: number }>("SELECT product_id, available FROM stock ORDER BY product_id");
      lastStock = new Map(rows.map((r) => [r.product_id, r.available]));
      return rows.filter((r) => r.available < RESTOCK_THRESHOLD);
    });
    if (low.length === 0) return;
    await tracer.startActiveSpan("inventory.restock", { attributes: { "restock.products": low.length } }, async (span) => {
      try {
        await pool.query("UPDATE stock SET available = available + $2, updated_at = now() WHERE product_id = ANY($1)", [
          low.map((l) => l.product_id),
          RESTOCK_AMOUNT,
        ]);
        restocks.add(low.length);
        logger.info({ products: low.map((l) => l.product_id), amount: RESTOCK_AMOUNT }, `supplier restocked ${low.length} low products by +${RESTOCK_AMOUNT}: ${low.map((l) => `${l.product_id} (${l.available} left)`).join(", ")}`);
      } finally {
        span.end();
      }
    });
  });

  await start(app, PORT, [stopRestock, () => consumer.disconnect(), () => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "inventory failed to start");
  process.exit(1);
});
