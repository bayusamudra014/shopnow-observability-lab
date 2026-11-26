/**
 * In-memory request statistics for the dashboard: per target, per endpoint, per status
 * code, with 10-second time buckets for the last 15 minutes.
 */

const BUCKET_MS = 10_000;
const KEEP_BUCKETS = 90; // 15 minutes
const LATENCY_SAMPLES = 500;

export type StatusKey = "2xx" | "3xx" | "4xx" | "5xx" | "error";
const statusKeys: StatusKey[] = ["2xx", "3xx", "4xx", "5xx", "error"];

interface Counts {
  total: number;
  byClass: Record<StatusKey, number>;
  latencySum: number;
}
const emptyCounts = (): Counts => ({ total: 0, byClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, error: 0 }, latencySum: 0 });

interface Endpoint {
  target: string;
  method: string;
  route: string;
  total: number;
  codes: Record<string, number>;
  latencies: number[];
  lastStatus: number | "error";
  lastAt: number;
  lastError?: string;
}

export interface RequestRecord {
  at: number;
  target: string;
  method: string;
  path: string;
  route: string;
  status: number | "error";
  ms: number;
  error?: string;
  requestId?: string;
  journey?: string;
}

const buckets = new Map<number, Map<string, Counts>>();
const endpoints = new Map<string, Endpoint>();
const recent: RequestRecord[] = [];
const recentFailures: RequestRecord[] = [];
const startedAt = Date.now();

/** /orders/0b5e...-uuid -> /orders/:id, /catalog/products/p001 -> /catalog/products/:id */
export function routeOf(path: string): string {
  return path
    .split("?")[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/p\d{3}\b/g, "/:id");
}

const classOf = (status: number | "error"): StatusKey => (status === "error" ? "error" : (`${Math.floor(status / 100)}xx` as StatusKey));

export function record(r: RequestRecord) {
  const bucketStart = Math.floor(r.at / BUCKET_MS) * BUCKET_MS;
  let bucket = buckets.get(bucketStart);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketStart, bucket);
    for (const k of buckets.keys()) if (k < bucketStart - KEEP_BUCKETS * BUCKET_MS) buckets.delete(k);
  }
  const c = bucket.get(r.target) ?? emptyCounts();
  c.total++;
  c.byClass[classOf(r.status)]++;
  c.latencySum += r.ms;
  bucket.set(r.target, c);

  const key = `${r.target}|${r.method} ${r.route}`;
  let e = endpoints.get(key);
  if (!e) {
    e = { target: r.target, method: r.method, route: r.route, total: 0, codes: {}, latencies: [], lastStatus: r.status, lastAt: r.at };
    endpoints.set(key, e);
  }
  e.total++;
  e.codes[String(r.status)] = (e.codes[String(r.status)] ?? 0) + 1;
  e.latencies.push(r.ms);
  if (e.latencies.length > LATENCY_SAMPLES) e.latencies.shift();
  e.lastStatus = r.status;
  e.lastAt = r.at;
  if (r.status === "error" || r.status >= 500) e.lastError = r.error ?? `HTTP ${r.status}`;

  recent.unshift(r);
  if (recent.length > 100) recent.pop();
  if (r.status === "error" || r.status >= 400) {
    recentFailures.unshift(r);
    if (recentFailures.length > 100) recentFailures.pop();
  }
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function reset() {
  buckets.clear();
  endpoints.clear();
  recent.length = 0;
  recentFailures.length = 0;
}

/** Everything the dashboard needs, optionally for one target only. */
export function snapshot(target?: string) {
  const match = (t: string) => !target || target === "all" || t === target;
  const now = Date.now();
  const first = Math.floor(now / BUCKET_MS) * BUCKET_MS - (KEEP_BUCKETS - 1) * BUCKET_MS;

  const series = [];
  for (let t = first; t <= now; t += BUCKET_MS) {
    const sum = emptyCounts();
    for (const [name, c] of buckets.get(t) ?? []) {
      if (!match(name)) continue;
      sum.total += c.total;
      sum.latencySum += c.latencySum;
      for (const k of statusKeys) sum.byClass[k] += c.byClass[k];
    }
    series.push({ t, ...sum.byClass, total: sum.total, avgMs: sum.total ? Math.round(sum.latencySum / sum.total) : 0 });
  }

  // Last minute summary (6 buckets; the current one is partial).
  const lastMinute = series.slice(-7, -1);
  const minuteTotal = lastMinute.reduce((n, b) => n + b.total, 0);
  const minuteFailed = lastMinute.reduce((n, b) => n + b["5xx"] + b.error, 0);
  const minute4xx = lastMinute.reduce((n, b) => n + b["4xx"], 0);

  const eps = [...endpoints.values()]
    .filter((e) => match(e.target))
    .map((e) => {
      const sorted = [...e.latencies].sort((a, b) => a - b);
      return {
        target: e.target,
        method: e.method,
        route: e.route,
        total: e.total,
        codes: e.codes,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        lastStatus: e.lastStatus,
        lastAt: new Date(e.lastAt).toISOString(),
        lastError: e.lastError,
      };
    })
    .sort((a, b) => b.total - a.total);

  const codes: Record<string, number> = {};
  for (const e of eps) for (const [code, n] of Object.entries(e.codes)) codes[code] = (codes[code] ?? 0) + n;

  const allLatencies = eps.length ? [...endpoints.values()].filter((e) => match(e.target)).flatMap((e) => e.latencies).sort((a, b) => a - b) : [];

  return {
    since: new Date(startedAt).toISOString(),
    bucketSeconds: BUCKET_MS / 1000,
    summary: {
      rps: Math.round((minuteTotal / 60) * 10) / 10,
      serverErrorRate: minuteTotal ? Math.round((minuteFailed / minuteTotal) * 1000) / 10 : 0,
      clientErrorRate: minuteTotal ? Math.round((minute4xx / minuteTotal) * 1000) / 10 : 0,
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      totalRequests: eps.reduce((n, e) => n + e.total, 0),
    },
    codes,
    series,
    endpoints: eps,
    recent: recent.filter((r) => match(r.target)).slice(0, 40).map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
    recentFailures: recentFailures.filter((r) => match(r.target)).slice(0, 40).map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  };
}
