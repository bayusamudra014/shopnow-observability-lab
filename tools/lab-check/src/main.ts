/**
 * lab-check: grades the ShopNow incident challenges from INSIDE a student's cluster.
 *
 * Run by the kit's check.sh / check.ps1 as a Job (from the suspended CronJob shop/lab-check)
 * with a read-only ServiceAccount. It looks at the cluster's live state (Kubernetes API,
 * the shop's databases) and replays the symptoms against the ingress, then prints one line
 * per ticket. It never changes anything.
 *
 * Environment (set by the CronJob): SHOP_PUBLIC_URL, POSTGRES_PASSWORD, INSTRUCTOR_PASSWORD,
 * BAD_TAG, INGRESS_URL (default: the ingress-nginx controller Service).
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { createPool } from "@shop/telemetry";

const SHOP_HOST = new URL(process.env.SHOP_PUBLIC_URL ?? "http://shop.localhost").hostname;
const INGRESS = process.env.INGRESS_URL ?? "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local";
const BAD_TAG = process.env.BAD_TAG ?? "";
const PG = (db: string) => `postgres://shop:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}@postgres.infra.svc.cluster.local:5432/${db}`;

// ------------------------------------------------------------------------ Kubernetes API
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const kubeToken = () => readFileSync(`${SA}/token`, "utf8");
const kubeCa = (() => {
  try {
    return readFileSync(`${SA}/ca.crt`);
  } catch {
    return undefined;
  }
})();

function kube<T = any>(path: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "kubernetes.default.svc", port: 443, path, method: "GET", ca: kubeCa, headers: { authorization: `Bearer ${kubeToken()}` }, timeout: 10_000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`kubernetes API ${path}: HTTP ${res.statusCode}`));
          resolve(JSON.parse(body) as T);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`kubernetes API ${path}: timeout`)));
    req.on("error", reject);
    req.end();
  });
}
const deployment = (name: string, ns = "shop") => kube(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
const container = (d: any) => d?.spec?.template?.spec?.containers?.[0] ?? {};
const envOf = (d: any, name: string): string | undefined => container(d).env?.find((e: any) => e.name === name)?.value;
const imageTag = (d: any): string => String(container(d).image ?? "").split(":").pop() ?? "";

/** Kubernetes quantity -> number (CPU in cores, memory in bytes). */
function quantity(q: string | undefined): number | undefined {
  if (q === undefined) return undefined;
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(String(q));
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit: Record<string, number> = { "": 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };
  return n * (unit[m[2]] ?? 1);
}

async function hpaFor(name: string, ns = "shop") {
  const list = await kube<{ items: any[] }>(`/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`);
  return list?.items.find((h) => h.spec?.scaleTargetRef?.kind === "Deployment" && h.spec?.scaleTargetRef?.name === name) ?? null;
}

// ---------------------------------------------------------------------- HTTP via ingress
// node:http, not fetch: fetch drops a custom Host header, and the ingress routes by host.
function shop(method: string, path: string, opts: { body?: unknown; token?: string; clientIp?: string } = {}): Promise<{ status: number; data: any }> {
  const url = new URL(path, INGRESS);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { host: SHOP_HOST, accept: "application/json" };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.clientIp) headers["x-forwarded-for"] = opts.clientIp;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method, headers, timeout: 20_000 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let data: any;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          data = undefined;
        }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path}: timeout`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function login(username: string, password: string, clientIp: string) {
  return shop("POST", "/api/auth/oauth/token", { body: { grant_type: "password", username, password, client_id: "lab-check" }, clientIp });
}

// ------------------------------------------------------------------------------ checks
type Result = { ok: boolean; detail: string };
interface Check {
  id: number;
  title: string;
  run: () => Promise<Result>;
}
const pass = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string): Result => ({ ok: false, detail });

const checks: Check[] = [
  {
    id: 1,
    title: "Product pages are fast",
    async run() {
      const catalog = await deployment("catalog");
      const nPlusOne = (envOf(catalog, "CATALOG_N_PLUS_ONE") ?? "true").toLowerCase() !== "false";
      const pool = createPool(PG("catalog_db"));
      try {
        const { rows } = await pool.query("EXPLAIN SELECT avg(rating), count(*) FROM product_reviews WHERE product_id = 'p001'");
        const plan = rows.map((r: any) => r["QUERY PLAN"]).join(" ");
        const indexed = /Index|Bitmap/i.test(plan);
        if (nPlusOne && !indexed) return fail("listing products still runs one slow rating query per product");
        if (nPlusOne) return fail("rating lookups are fast now, but listing products still runs one query per product");
        if (!indexed) return fail("the product list is one query now, but each rating lookup still reads the whole reviews table");
        return pass("one query per product list, and rating lookups use an index");
      } finally {
        await pool.end();
      }
    },
  },
  {
    id: 2,
    title: "Checkout survives a slow payment provider",
    async run() {
      const payment = await deployment("payment");
      const timeout = Number(envOf(payment, "PROVIDER_TIMEOUT_MS") ?? 3000);
      const attempts = Number(envOf(payment, "PROVIDER_MAX_ATTEMPTS") ?? 3);
      // Retries back off 200, 400, 800 ms ...; the order service gives payment 12 s in total.
      const worst = timeout * attempts + Array.from({ length: Math.max(0, attempts - 1) }, (_, i) => 200 * 2 ** i).reduce((a, b) => a + b, 0);
      if (timeout < 4500) return fail(`calls to the provider give up after ${timeout} ms, faster than it answers when it is slow (up to ~4 s)`);
      if (worst > 11_500) return fail(`a payment can take ${(worst / 1000).toFixed(1)} s with retries, longer than checkout waits for it (12 s)`);
      return pass(`each call waits ${timeout} ms, ${attempts} attempt(s), worst case ${(worst / 1000).toFixed(1)} s (checkout waits 12 s)`);
    },
  },
  {
    id: 3,
    title: "Payment results (webhooks) reach the shop",
    async run() {
      const r = await shop("POST", "/webhooks/payment-provider", { body: {} });
      if (r.status === 400 || r.status === 401) {
        const pool = createPool(PG("order_db"));
        try {
          const { rows } = await pool.query(
            "SELECT count(*)::int AS n FROM orders WHERE status = 'awaiting_payment' AND created_at BETWEEN now() - interval '30 minutes' AND now() - interval '3 minutes'",
          );
          const stuck = rows[0].n as number;
          return pass(`the webhook endpoint answers (HTTP ${r.status} for an unsigned test call)${stuck ? `; ${stuck} older order(s) still waiting` : ""}`);
        } finally {
          await pool.end();
        }
      }
      return fail(`a call to ${SHOP_HOST}/webhooks/payment-provider gets HTTP ${r.status} at the ingress, so the provider's results never arrive`);
    },
  },
  {
    id: 4,
    title: "The shop has capacity for Black Friday",
    async run() {
      const gw = await deployment("api-gateway");
      const limit = quantity(container(gw).resources?.limits?.cpu);
      const request = quantity(container(gw).resources?.requests?.cpu);
      const hpa = await hpaFor("api-gateway");
      if (limit !== undefined && limit < 0.5) return fail(`api-gateway may use at most ${Math.round(limit * 1000)}m CPU, so it is throttled under load`);
      if (!hpa) return fail("api-gateway runs a fixed number of replicas; nothing adds more when traffic grows");
      if ((hpa.spec?.maxReplicas ?? 1) < 2) return fail("the api-gateway autoscaler can never add a replica (maxReplicas < 2)");
      if (!request) return fail("the api-gateway autoscaler has no CPU request to scale against");
      return pass(`api-gateway: CPU limit ${limit === undefined ? "none" : `${Math.round(limit * 1000)}m`}, autoscaled ${hpa.spec.minReplicas ?? 1}-${hpa.spec.maxReplicas} replicas`);
    },
  },
  {
    id: 5,
    title: "Order emails are sent (notification stays up)",
    async run() {
      const d = await deployment("notification");
      const limit = quantity(container(d).resources?.limits?.memory);
      const pods = await kube<{ items: any[] }>(`/api/v1/namespaces/shop/pods?labelSelector=app%3Dnotification`);
      const recentOom = (pods?.items ?? []).some((p) =>
        (p.status?.containerStatuses ?? []).some((c: any) => {
          const t = c.lastState?.terminated;
          return t?.reason === "OOMKilled" && Date.now() - Date.parse(t.finishedAt) < 10 * 60_000;
        }),
      );
      if (limit !== undefined && limit < 256 * 1024 ** 2) return fail(`notification may use at most ${Math.round(limit / 1024 ** 2)} MiB of memory, less than it needs`);
      if (recentOom) return fail("a notification pod was killed for running out of memory in the last 10 minutes");
      return pass(`memory limit ${limit === undefined ? "none" : `${Math.round(limit / 1024 ** 2)} MiB`}, no out-of-memory kills in the last 10 minutes`);
    },
  },
  {
    id: 6,
    title: "Emails keep up with orders",
    async run() {
      const d = await deployment("notification");
      const delay = envOf(d, "NOTIFICATION_DELAY_MS");
      if (delay !== "2000") return fail("the slow mail relay (NOTIFICATION_DELAY_MS=2000) is part of the scenario: put it back and fix the throughput instead");
      const topics = await Promise.all(
        ["order.placed", "order.confirmed"].map(async (t) => ({ t, n: (await kube(`/apis/kafka.strimzi.io/v1beta2/namespaces/infra/kafkatopics/${t}`))?.spec?.partitions ?? 0 })),
      );
      const hpa = await hpaFor("notification");
      const replicas = hpa ? (hpa.spec?.minReplicas ?? 1) : (d?.spec?.replicas ?? 1);
      const few = topics.filter((x) => x.n < replicas || x.n < 2);
      if (replicas < 2) return fail("one notification consumer sends every email, one at a time");
      if (few.length) return fail(`${few.map((x) => `${x.t} has ${x.n} partition(s)`).join(", ")}: extra consumers have nothing to read`);
      return pass(`${replicas}+ consumers; ${topics.map((x) => `${x.t} ${x.n}`).join(", ")} partitions`);
    },
  },
  {
    id: 7,
    title: "Login stays fast during credential stuffing",
    async run() {
      const password = process.env.INSTRUCTOR_PASSWORD ?? "";
      const attacker = "203.0.113.66";
      // A burst of bad logins from one address, like the botnet ...
      let blocked = 0;
      await Promise.all(
        Array.from({ length: 4 }, async (_, w) => {
          for (let i = 0; i < 15; i++) {
            const r = await login(`leaked-${w}-${i}`, "123456", attacker);
            if (r.status === 429 || r.status === 503) blocked++;
          }
        }),
      );
      // ... must not lock out real customers on other addresses.
      const customers = await Promise.all([1, 2, 3].map((i) => login("instructor", password, `198.51.100.${10 + i}`)));
      const lockedOut = customers.filter((r) => r.status !== 200).length;
      if (!blocked) return fail("60 bad logins in a few seconds from one address were all processed");
      if (lockedOut) return fail(`the burst was limited, but ${lockedOut} of 3 real customers on other addresses were blocked too`);
      return pass(`${blocked} of 60 bad logins from one address were rejected; customers on other addresses got in`);
    },
  },
  {
    id: 8,
    title: "Checkout works after last night's release",
    async run() {
      const [order, catalog] = await Promise.all([deployment("order"), deployment("catalog")]);
      const tag = imageTag(order);
      // Retry briefly: a rate limit (ticket 7) may still be cooling down from the last check.
      let login1 = await login("instructor", process.env.INSTRUCTOR_PASSWORD ?? "", "198.51.100.99");
      for (let i = 0; i < 10 && (login1.status === 429 || login1.status === 503); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        login1 = await login("instructor", process.env.INSTRUCTOR_PASSWORD ?? "", "198.51.100.99");
      }
      if (login1.status !== 200) return fail(`could not sign in to test a checkout (HTTP ${login1.status})`);
      const token = login1.data.access_token as string;
      await shop("DELETE", "/api/cart", { token });
      const add = await shop("POST", "/api/cart/items", { token, body: { productId: "p001", quantity: 3 } });
      if (add.status !== 201) return fail(`could not fill a test cart (HTTP ${add.status})`);
      const res = await shop("POST", "/api/orders", { token, body: {} });
      // Leave nothing behind: an order the payment provider settles like any other.
      await shop("DELETE", "/api/cart", { token });
      const note = BAD_TAG && imageTag(catalog) === BAD_TAG ? `; catalog is still on ${BAD_TAG} (that part of the release was fine)` : "";
      if (res.status >= 500 && res.status !== 503) return fail(`a checkout of 3 x Wireless Headphones fails with HTTP ${res.status} (order ${tag})`);
      if (BAD_TAG && tag === BAD_TAG) return fail(`order still runs ${tag}`);
      return pass(`a checkout of 3 x Wireless Headphones works (HTTP ${res.status}, order ${tag})${note}`);
    },
  },
];

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const selected = only.length ? checks.filter((c) => only.includes(c.id)) : checks;
  console.log(`\nShopNow incident checks for ${SHOP_HOST}  (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
  let passed = 0;
  for (const c of selected) {
    let r: Result;
    try {
      r = await c.run();
    } catch (err) {
      r = fail(`could not check: ${(err as Error).message}`);
    }
    if (r.ok) passed++;
    console.log(`  ${r.ok ? "FIXED " : "BROKEN"}  ${c.id}. ${c.title}`);
    console.log(`          ${r.detail}`);
  }
  console.log(`\n  ${passed} of ${selected.length} fixed   (check id: ${randomUUID().slice(0, 8)})\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
