import { HttpError } from "./server.js";

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CallResult<T> {
  status: number;
  data: T;
}

/**
 * JSON call to another service. Node's fetch (undici) is auto-instrumented, so the W3C
 * `traceparent` header is injected and the downstream span joins this trace.
 * Network errors and timeouts become HttpError(503) so callers can decide what to do.
 */
export async function callService<T = any>(baseUrl: string, path: string, opts: CallOptions = {}): Promise<CallResult<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? "timeout" : "unreachable";
    throw new HttpError(503, `${new URL(baseUrl).host} ${reason}: ${e.message}`, `upstream_${reason}`);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data: data as T };
}
