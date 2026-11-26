/**
 * Client for the EXTERNAL payment provider, with the usual resilience patterns:
 * timeout, retry with exponential backoff (only for retryable failures), and a circuit
 * breaker. The provider is a black box: we only see our own client spans.
 */
import { callService, HttpError, logger, metrics, sleep, env, envNumber } from "@shop/telemetry";

const PROVIDER_URL = env("PROVIDER_URL", "http://payment-provider.external:8080");
const API_KEY = env("PROVIDER_API_KEY");
/** Public URL where the provider must POST this shop's webhooks (empty: provider default). */
const WEBHOOK_CALLBACK_URL = process.env.PROVIDER_WEBHOOK_CALLBACK_URL ?? "";
const TIMEOUT_MS = envNumber("PROVIDER_TIMEOUT_MS", 3000);
const MAX_ATTEMPTS = envNumber("PROVIDER_MAX_ATTEMPTS", 3);
const BREAKER_THRESHOLD = envNumber("PROVIDER_BREAKER_THRESHOLD", 5);
const BREAKER_COOLDOWN_MS = envNumber("PROVIDER_BREAKER_COOLDOWN_MS", 30_000);

const meter = metrics.getMeter("payment");
const providerRequests = meter.createCounter("shop_payment_provider_requests_total", {
  description: "Calls to the external payment provider by operation and outcome",
});

export interface Charge {
  id: string;
  status: "pending" | "succeeded" | "failed";
  amountCents: number;
  merchantReference: string;
  failureCode?: string;
}

// --- circuit breaker ------------------------------------------------------------------
type State = "closed" | "open" | "half_open";
let state: State = "closed";
let failures = 0;
let openedAt = 0;
const stateValue: Record<State, number> = { closed: 0, open: 1, half_open: 2 };
meter
  .createObservableGauge("shop_payment_provider_circuit_state", { description: "0 = closed, 1 = open, 2 = half-open" })
  .addCallback((o) => o.observe(stateValue[state]));

function setState(next: State, why: string) {
  if (state === next) return;
  const level = next === "open" ? "error" : "warn";
  logger[level]({ from: state, to: next, failures, why, event: "payment.circuit_state_changed" }, `provider circuit breaker ${next}`);
  state = next;
}

function beforeCall() {
  if (state === "open") {
    if (Date.now() - openedAt < BREAKER_COOLDOWN_MS) throw new HttpError(503, "provider circuit breaker is open", "circuit_open");
    setState("half_open", "cooldown elapsed, trying one request");
  }
}

function onSuccess() {
  failures = 0;
  setState("closed", "request succeeded");
}

function onFailure() {
  failures++;
  if (state === "half_open" || failures >= BREAKER_THRESHOLD) {
    openedAt = Date.now();
    setState("open", `${failures} consecutive failures`);
  }
}

const retryable = (status: number) => status >= 500 || status === 429;

async function request<T>(op: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    beforeCall();
    try {
      const res = await callService<T>(PROVIDER_URL, path, {
        ...init,
        timeoutMs: TIMEOUT_MS,
        headers: { authorization: `Bearer ${API_KEY}`, ...init.headers },
      });
      if (!retryable(res.status)) {
        onSuccess(); // the provider answered properly (even a decline is a healthy answer)
        providerRequests.add(1, { operation: op, outcome: res.status < 400 ? "ok" : `http_${res.status}` });
        return res;
      }
      last = new HttpError(502, `provider returned ${res.status}`, "provider_error");
      providerRequests.add(1, { operation: op, outcome: `http_${res.status}` });
    } catch (err) {
      last = err;
      const code = err instanceof HttpError ? err.code : "error";
      providerRequests.add(1, { operation: op, outcome: code });
      if (code === "circuit_open") throw err;
    }
    onFailure();
    if (attempt < MAX_ATTEMPTS) {
      const delay = 200 * 2 ** (attempt - 1);
      logger.warn({ op, attempt, delayMs: delay, err: (last as Error).message }, `provider ${op} failed (attempt ${attempt}), retrying in ${delay} ms: ${(last as Error).message}`);
      await sleep(delay);
    }
  }
  throw last;
}

export async function createCharge(paymentId: string, amountCents: number, orderId: string) {
  return request<Charge & { error?: string; charge?: Charge }>("create_charge", "/v1/charges", {
    method: "POST",
    // Same idempotency key on every retry: the provider must not charge twice.
    headers: { "idempotency-key": paymentId },
    // With a shared provider, tell it where THIS shop receives webhooks.
    body: { amountCents, currency: "USD", merchantReference: paymentId, description: `Order ${orderId}`, webhookUrl: WEBHOOK_CALLBACK_URL || undefined },
  });
}

export async function getCharge(chargeId: string) {
  return request<Charge>("get_charge", `/v1/charges/${encodeURIComponent(chargeId)}`);
}

export async function findChargeByReference(paymentId: string) {
  return request<{ items: Charge[] }>("find_charge", `/v1/charges?merchantReference=${encodeURIComponent(paymentId)}`);
}

export async function refundCharge(chargeId: string, reason: string) {
  return request<{ id: string; status: string }>("refund", "/v1/refunds", {
    method: "POST",
    headers: { "idempotency-key": `refund-${chargeId}` },
    body: { chargeId, reason },
  });
}

export const circuitState = () => state;
