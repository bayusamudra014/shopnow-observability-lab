/**
 * catalog: products, categories and ratings.
 *
 * Teaching points
 *  - Redis cache-aside: span attribute `cache.hit` + metric `shop_cache_requests_total`.
 *    If Redis is down the service keeps working (slower) and logs a warning.
 *  - Deliberate N+1 query: listing products loads the rating of each product with a
 *    separate query (CATALOG_N_PLUS_ONE=true, the default). Set it to false to use one
 *    aggregated query instead and compare the traces.
 */
import path from "node:path";
import { Redis } from "ioredis";
import { z } from "zod";
import { createServer, createPool, migrate, start, HttpError, logger, metrics, trace, env, envBool, envNumber } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const N_PLUS_ONE = envBool("CATALOG_N_PLUS_ONE", true);
const LIST_TTL = envNumber("CACHE_LIST_TTL_SECONDS", 30);
const ITEM_TTL = envNumber("CACHE_ITEM_TTL_SECONDS", 60);

const pool = createPool();
const redis = new Redis(env("REDIS_URL", "redis://redis:6379"), {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
  commandTimeout: 500,
});
redis.on("error", (err) => logger.warn({ err: err.message }, `redis error: ${err.message}`));

const meter = metrics.getMeter("catalog");
const cacheRequests = meter.createCounter("shop_cache_requests_total", { description: "Cache lookups by cache and result (hit, miss, error)" });

/** Cache-aside: try Redis, fall back to the loader, then fill the cache. */
async function cached<T>(cache: string, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const span = trace.getActiveSpan();
  try {
    const hit = await redis.get(key);
    if (hit) {
      cacheRequests.add(1, { cache, result: "hit" });
      span?.setAttribute("cache.hit", true);
      return JSON.parse(hit) as T;
    }
    cacheRequests.add(1, { cache, result: "miss" });
  } catch (err) {
    cacheRequests.add(1, { cache, result: "error" });
    logger.warn({ err: (err as Error).message, key }, `cache read failed for ${key}, falling back to database: ${(err as Error).message}`);
  }
  span?.setAttribute("cache.hit", false);
  const value = await load();
  redis.set(key, JSON.stringify(value), "EX", ttl).catch((err) => logger.warn({ err: err.message, key }, `cache write failed for ${key}: ${err.message}`));
  return value;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  emoji: string;
  price_cents: number;
}

const toProduct = (r: ProductRow, rating?: { avg: number | null; count: number }) => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  description: r.description,
  category: r.category,
  emoji: r.emoji,
  priceCents: r.price_cents,
  rating: rating ? { average: rating.avg === null ? null : Math.round(Number(rating.avg) * 10) / 10, count: Number(rating.count) } : undefined,
});

const ListQuery = z.object({
  category: z.string().optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).default(0),
});

async function listProducts(q: z.infer<typeof ListQuery>) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.category) {
    args.push(q.category);
    where.push(`category = $${args.length}`);
  }
  if (q.q) {
    args.push(`%${q.q}%`);
    where.push(`(name ILIKE $${args.length} OR description ILIKE $${args.length})`);
  }
  args.push(q.limit, q.offset);
  const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT $${args.length - 1} OFFSET $${args.length}`;
  const { rows } = await pool.query<ProductRow>(sql, args);

  if (N_PLUS_ONE) {
    // Anti-pattern on purpose: one extra query per product.
    const out = [];
    for (const r of rows) {
      const rating = await pool.query("SELECT avg(rating) AS avg, count(*) AS count FROM product_reviews WHERE product_id = $1", [r.id]);
      out.push(toProduct(r, rating.rows[0]));
    }
    return out;
  }
  const ratings = await pool.query(
    "SELECT product_id, avg(rating) AS avg, count(*) AS count FROM product_reviews WHERE product_id = ANY($1) GROUP BY product_id",
    [rows.map((r) => r.id)],
  );
  const byId = new Map(ratings.rows.map((x) => [x.product_id, x]));
  return rows.map((r) => toProduct(r, byId.get(r.id) ?? { avg: null, count: 0 }));
}

const app = createServer({ ready: async () => void (await pool.query("SELECT 1")) });

app.get("/products", async (req) => {
  const q = ListQuery.parse(req.query);
  trace.getActiveSpan()?.setAttributes({ "catalog.category": q.category ?? "", "catalog.search": q.q ?? "" });
  const key = `catalog:list:${q.category ?? "*"}:${q.q ?? ""}:${q.limit}:${q.offset}`;
  const items = await cached("product_list", key, LIST_TTL, () => listProducts(q));
  return { items, limit: q.limit, offset: q.offset };
});

app.get("/products/:id", async (req) => {
  const { id } = z.object({ id: z.string().max(20) }).parse(req.params);
  trace.getActiveSpan()?.setAttribute("product.id", id);
  const product = await cached("product", `catalog:product:${id}`, ITEM_TTL, async () => {
    const { rows } = await pool.query<ProductRow>("SELECT * FROM products WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const rating = await pool.query("SELECT avg(rating) AS avg, count(*) AS count FROM product_reviews WHERE product_id = $1", [id]);
    const reviews = await pool.query(
      "SELECT rating, comment, created_at FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC LIMIT 5",
      [id],
    );
    return { ...toProduct(rows[0], rating.rows[0]), reviews: reviews.rows.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: r.created_at })) };
  });
  if (!product) throw new HttpError(404, `product ${id} not found`, "product_not_found");
  return product;
});

app.get("/categories", async () =>
  cached("categories", "catalog:categories", ITEM_TTL, async () => {
    const { rows } = await pool.query("SELECT category, count(*)::int AS count FROM products GROUP BY category ORDER BY category");
    return rows;
  }),
);

async function main() {
  await migrate(pool, path.join(__dirname, "../migrations"));
  logger.info({ nPlusOne: N_PLUS_ONE }, `catalog started, N+1 query mode ${N_PLUS_ONE ? "ON (slow product list)" : "off"}`);
  await start(app, PORT, [() => pool.end(), () => redis.quit()]);
}

main().catch((err) => {
  logger.fatal({ err }, "catalog failed to start");
  process.exit(1);
});
