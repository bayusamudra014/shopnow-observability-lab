import { envNumber } from "@shop/telemetry";
import { z } from "zod";

/** Failure knobs. All rates are probabilities between 0 and 1. */
export const ChaosSchema = z.object({
  /** Fixed extra latency added to every API call. */
  latencyMs: z.number().int().min(0).max(60_000),
  /** Random extra latency between 0 and this value. */
  latencyJitterMs: z.number().int().min(0).max(60_000),
  /** Answer 500/503 without doing anything. */
  errorRate: z.number().min(0).max(1),
  /** Create the charge, then hang for 30s (the client times out but the charge exists!). */
  timeoutRate: z.number().min(0).max(1),
  /** Decline synchronously with HTTP 402. */
  declineRate: z.number().min(0).max(1),
  /** Accept (pending) but fail later via the webhook. */
  asyncDeclineRate: z.number().min(0).max(1),
  /** Time between charge creation and the webhook. */
  webhookDelayMs: z.number().int().min(0).max(600_000),
  /** Send the same webhook event twice. */
  duplicateWebhookRate: z.number().min(0).max(1),
  /** Sign the webhook with the wrong secret. */
  badSignatureRate: z.number().min(0).max(1),
  /** Never send the webhook at all. */
  dropWebhookRate: z.number().min(0).max(1),
  /** Delivery attempts per webhook before giving up (retries use exponential backoff). */
  webhookMaxAttempts: z.number().int().min(1).max(10),
  /** How long a "timeout" charge hangs before answering. */
  hangMs: z.number().int().min(1000).max(120_000),
});
export type Chaos = z.infer<typeof ChaosSchema>;

export const defaults = (): Chaos => ({
  latencyMs: envNumber("CHAOS_LATENCY_MS", 80),
  latencyJitterMs: envNumber("CHAOS_LATENCY_JITTER_MS", 120),
  errorRate: envNumber("CHAOS_ERROR_RATE", 0),
  timeoutRate: envNumber("CHAOS_TIMEOUT_RATE", 0),
  declineRate: envNumber("CHAOS_DECLINE_RATE", 0.03),
  asyncDeclineRate: envNumber("CHAOS_ASYNC_DECLINE_RATE", 0.02),
  webhookDelayMs: envNumber("CHAOS_WEBHOOK_DELAY_MS", 2000),
  duplicateWebhookRate: envNumber("CHAOS_DUPLICATE_WEBHOOK_RATE", 0.02),
  badSignatureRate: envNumber("CHAOS_BAD_SIGNATURE_RATE", 0),
  dropWebhookRate: envNumber("CHAOS_DROP_WEBHOOK_RATE", 0),
  webhookMaxAttempts: envNumber("WEBHOOK_MAX_ATTEMPTS", 5),
  hangMs: envNumber("CHAOS_HANG_MS", 30_000),
});

export const chaos: Chaos = defaults();

export const roll = (rate: number) => Math.random() < rate;
