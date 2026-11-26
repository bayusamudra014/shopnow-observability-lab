/**
 * cart: the signed-in user's shopping cart (stored in Postgres).
 * Adding an item calls catalog synchronously to get the current name and price.
 */
import path from "node:path";
import { z } from "zod";
import {
  createServer, createPool, migrate, start, callService, forwardHeaders, requireUser, HttpError, logger, metrics, trace, env, envNumber,
} from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const CATALOG_URL = env("CATALOG_URL", "http://catalog:8080");
const MAX_QTY = 20;

const pool = createPool();
const meter = metrics.getMeter("cart");
const itemsAdded = meter.createCounter("shop_cart_items_added_total", { description: "Units added to carts" });
const itemsRemoved = meter.createCounter("shop_cart_items_removed_total", { description: "Lines removed from carts" });

interface Row {
  product_id: string;
  name: string;
  emoji: string;
  unit_price_cents: number;
  quantity: number;
}

async function loadCart(userId: string) {
  const { rows } = await pool.query<Row>("SELECT * FROM cart_items WHERE user_id = $1 ORDER BY added_at", [userId]);
  const items = rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    emoji: r.emoji,
    unitPriceCents: r.unit_price_cents,
    quantity: r.quantity,
    lineTotalCents: r.unit_price_cents * r.quantity,
  }));
  return {
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    totalCents: items.reduce((n, i) => n + i.lineTotalCents, 0),
  };
}

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

app.get("/cart", async (req) => loadCart(requireUser(req).id));

app.post("/cart/items", async (req, reply) => {
  const user = requireUser(req);
  const body = z.object({ productId: z.string().min(1).max(20), quantity: z.number().int().min(1).max(MAX_QTY) }).parse(req.body);
  trace.getActiveSpan()?.setAttributes({ "product.id": body.productId, "cart.quantity": body.quantity });

  const product = await callService(CATALOG_URL, `/products/${encodeURIComponent(body.productId)}`, { headers: forwardHeaders(req) });
  if (product.status === 404) throw new HttpError(404, `product ${body.productId} not found`, "product_not_found");
  if (product.status !== 200) throw new HttpError(502, `catalog returned ${product.status}`, "catalog_error");

  await pool.query(
    `INSERT INTO cart_items (user_id, product_id, name, emoji, unit_price_cents, quantity) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, product_id) DO UPDATE
       SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, ${MAX_QTY}), unit_price_cents = EXCLUDED.unit_price_cents`,
    [user.id, body.productId, product.data.name, product.data.emoji ?? "", product.data.priceCents, body.quantity],
  );
  itemsAdded.add(body.quantity);
  logger.info({ userId: user.id, productId: body.productId, quantity: body.quantity },
    `${user.email.split("@")[0]} added ${body.quantity} × ${product.data.name} (${body.productId}, $${(product.data.priceCents / 100).toFixed(2)} each) to cart`);
  return reply.status(201).send(await loadCart(user.id));
});

app.patch("/cart/items/:productId", async (req) => {
  const user = requireUser(req);
  const { productId } = z.object({ productId: z.string() }).parse(req.params);
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(MAX_QTY) }).parse(req.body);
  const res = await pool.query("UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND product_id = $2", [user.id, productId, quantity]);
  if (res.rowCount === 0) throw new HttpError(404, `${productId} is not in the cart`, "not_in_cart");
  return loadCart(user.id);
});

app.delete("/cart/items/:productId", async (req) => {
  const user = requireUser(req);
  const { productId } = z.object({ productId: z.string() }).parse(req.params);
  const res = await pool.query("DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2", [user.id, productId]);
  if (res.rowCount) itemsRemoved.add(1);
  return loadCart(user.id);
});

app.delete("/cart", async (req) => {
  const user = requireUser(req);
  await pool.query("DELETE FROM cart_items WHERE user_id = $1", [user.id]);
  return loadCart(user.id);
});

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  await start(app, PORT, [() => pool.end()]);
}

main().catch((err) => {
  logger.fatal({ err }, "cart failed to start");
  process.exit(1);
});
