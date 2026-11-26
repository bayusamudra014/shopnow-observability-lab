import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { logger } from "./logger.js";
import { envNumber, retry } from "./util.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString, max: envNumber("DB_POOL_MAX", 10) });
  pool.on("error", (err) => logger.error({ err }, `postgres pool error: ${err.message}`));
  return pool;
}

/**
 * Apply `*.sql` files from `dir` in name order, once each. An advisory lock makes it
 * safe when several replicas start at the same time.
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<void> {
  await retry("postgres", () => pool.query("SELECT 1"));
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info({ migration: file }, `migration ${file} applied`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
