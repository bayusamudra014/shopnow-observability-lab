import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logger } from "./logger.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const envNumber = (name: string, fallback: number) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};

export const envBool = (name: string, fallback: boolean) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

/** Retry an async operation (used while waiting for Postgres/Kafka to come up). */
export async function retry<T>(label: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn({ err: (err as Error).message, attempt: i }, `${label} not ready, retrying`);
      await sleep(delayMs);
    }
  }
}

/**
 * Run background polling work WITHOUT creating spans (otherwise every 500ms poll query
 * would show up as its own trace and drown the interesting ones).
 */
export function quietly<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(suppressTracing(context.active()), fn);
}

/** Run `fn` every `intervalMs`, never overlapping, logging (not crashing on) errors. */
export function every(label: string, intervalMs: number, fn: () => Promise<void>): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, `${label} failed`);
      }
      await sleep(intervalMs);
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
