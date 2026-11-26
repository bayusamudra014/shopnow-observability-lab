import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import type { Producer } from "kafkajs";
import type pg from "pg";
import { withTx } from "./db.js";
import { publish } from "./kafka.js";
import { every, quietly } from "./util.js";

/**
 * Transactional outbox.
 *
 * `enqueue` writes the event into the `outbox` table inside the SAME transaction as the
 * business change, so the event is never lost and never sent for a rolled-back change.
 * The current trace context is stored with the row, so when the relay publishes it later
 * the Kafka message still belongs to the original request's trace.
 *
 * Each service creates the table in its own migration:
 *   CREATE TABLE outbox (id bigserial PRIMARY KEY, topic text NOT NULL, key text NOT NULL,
 *     payload jsonb NOT NULL, headers jsonb NOT NULL DEFAULT '{}',
 *     created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
 */
export async function enqueue(client: pg.PoolClient, topic: string, key: string, payload: unknown): Promise<void> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await client.query("INSERT INTO outbox (topic, key, payload, headers) VALUES ($1, $2, $3, $4)", [
    topic,
    key,
    JSON.stringify(payload),
    JSON.stringify(carrier),
  ]);
}

interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: unknown;
  headers: Record<string, string>;
  created_at: Date;
}

const tracer = trace.getTracer("shop.outbox");

/** Poll the outbox and publish pending rows. Returns a stop function. */
export function startOutboxRelay(pool: pg.Pool, producer: Producer, intervalMs = 500): () => void {
  return every("outbox relay", intervalMs, () =>
    quietly(async () => {
      await withTx(pool, async (c) => {
        const { rows } = await c.query<OutboxRow>(
          "SELECT id, topic, key, payload, headers, created_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED",
        );
        if (rows.length === 0) return;
        for (const row of rows) {
          // Re-enter the trace of the request that created the event.
          const parent = propagation.extract(ROOT_CONTEXT, row.headers);
          await context.with(parent, () =>
            tracer.startActiveSpan(
              `outbox publish ${row.topic}`,
              {
                kind: SpanKind.INTERNAL,
                attributes: {
                  "messaging.destination.name": row.topic,
                  "outbox.id": row.id,
                  "outbox.lag_ms": Date.now() - new Date(row.created_at).getTime(),
                },
              },
              async (span) => {
                try {
                  await publish(producer, row.topic, row.key, row.payload);
                } finally {
                  span.end();
                }
              },
            ),
          );
        }
        await c.query("UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
      });
    }),
  );
}
