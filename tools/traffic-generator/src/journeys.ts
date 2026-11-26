/**
 * User journeys. Each one is a realistic sequence of API calls with think time between
 * steps. The engine wraps every journey in a root span named `journey.<name>`.
 */
import { randomUUID } from "node:crypto";
import { productIds } from "@shop/contracts";
import { sleep } from "@shop/telemetry";
import type { ApiClient, ApiResult, Target } from "./targets.js";

export type JourneyName = "window_shopper" | "cart_abandoner" | "buyer" | "returning_customer" | "misbehaving_client" | "credential_stuffer";
export const journeyNames: JourneyName[] = ["window_shopper", "cart_abandoner", "buyer", "returning_customer", "misbehaving_client", "credential_stuffer"];

export interface JourneyContext {
  target: Target;
  /** Products that get most of the attention (flash sale). */
  hotProducts: string[];
  /** Probability that an authenticated journey does a fresh password login. */
  freshLoginRate: number;
}

/** Outcome reported for metrics. Anything not "failed" is a valid result. */
export type Outcome = "completed" | "abandoned" | "order_confirmed" | "order_cancelled" | "order_pending" | "checkout_rejected" | "expected_error" | "blocked";

export class JourneyError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export const thinkTime = { minMs: Number(process.env.THINK_TIME_MIN_MS ?? 300), maxMs: Number(process.env.THINK_TIME_MAX_MS ?? 2000) };
const think = () => sleep(thinkTime.minMs + Math.random() * Math.max(0, thinkTime.maxMs - thinkTime.minMs));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const between = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const categories = ["electronics", "books", "home", "fashion", "sports"];

function pickProduct(ctx: JourneyContext) {
  return ctx.hotProducts.length && Math.random() < 0.8 ? pick(ctx.hotProducts) : pick(productIds);
}

/** Fail the journey on unexpected statuses (they become errors on the journey span). */
function expect(res: ApiResult, ...ok: number[]) {
  if (!ok.includes(res.status)) throw new JourneyError(`unexpected ${res.status}: ${res.data?.message ?? res.data?.error ?? ""}`, res.status);
  return res;
}

async function browse(api: ApiClient, ctx: JourneyContext, views: number) {
  const q = Math.random() < 0.4 ? `?category=${pick(categories)}` : "";
  expect(await api.get(`/catalog/products${q}`), 200);
  await think();
  for (let i = 0; i < views; i++) {
    const id = pickProduct(ctx);
    expect(await api.get(`/catalog/products/${id}`), 200);
    expect(await api.get(`/inventory/stock/${id}`), 200);
    await think();
  }
}

async function fillCart(api: ApiClient, ctx: JourneyContext, lines: number) {
  for (let i = 0; i < lines; i++) {
    expect(await api.post("/cart/items", { productId: pickProduct(ctx), quantity: between(1, 3) }), 201);
    await think();
  }
}

async function withUser<T>(ctx: JourneyContext, fn: (api: ApiClient) => Promise<T>): Promise<T> {
  const user = ctx.target.leaseUser();
  try {
    const api = await ctx.target.authenticate(user, Math.random() < ctx.freshLoginRate);
    return await fn(api);
  } finally {
    ctx.target.releaseUser(user);
  }
}

/** Place an order and poll it until the asynchronous payment finishes. */
async function checkout(api: ApiClient): Promise<Outcome> {
  const res = await api.post("/orders", {}, { "idempotency-key": randomUUID() });
  if (res.status === 409 || res.status === 503) return "checkout_rejected"; // out of stock / payment down: handled by the shop
  expect(res, 201, 200);
  const orderId: string = res.data.id;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const o = expect(await api.get(`/orders/${orderId}`), 200).data;
    if (o.status === "confirmed") return "order_confirmed";
    if (o.status === "cancelled") return "order_cancelled";
  }
  return "order_pending";
}

/** A leaked "combo list": common usernames and passwords, mixed with this shop's real usernames. */
const LEAKED_USERS = ["admin", "test", "john.doe", "jane", "michael", "sarah", "budi", "siti", "andi", "dewi", "user1", "demo"];
const LEAKED_PASSWORDS = ["123456", "password", "qwerty123", "iloveyou", "admin123", "Password1!", "letmein", "welcome1", "dragon", "sayang123", "indonesia1", "000000"];

const journeys: Record<JourneyName, (ctx: JourneyContext) => Promise<Outcome>> = {
  /** Anonymous browsing. */
  async window_shopper(ctx) {
    await browse(ctx.target.anonymous, ctx, between(2, 5));
    return "completed";
  },

  /** Signs in, adds to cart, leaves. */
  async cart_abandoner(ctx) {
    return withUser<Outcome>(ctx, async (api) => {
      await browse(api, ctx, between(1, 3));
      await fillCart(api, ctx, between(1, 2));
      const cart = expect(await api.get("/cart"), 200).data;
      if (cart.items.length && Math.random() < 0.5) {
        expect(await api.patch(`/cart/items/${cart.items[0].productId}`, { quantity: between(1, 5) }), 200);
      }
      if (Math.random() < 0.3) expect(await api.delete("/cart"), 200);
      return "abandoned";
    });
  },

  /** Browses, buys, waits for the payment result. */
  async buyer(ctx) {
    return withUser<Outcome>(ctx, async (api) => {
      await browse(api, ctx, between(1, 3));
      expect(await api.delete("/cart"), 200); // start from a clean cart
      await fillCart(api, ctx, between(1, 3));
      expect(await api.get("/cart"), 200);
      await think();
      return checkout(api);
    });
  },

  /** Looks at order history, sometimes re-orders. Always does a fresh login. */
  async returning_customer(ctx) {
    return withUser<Outcome>({ ...ctx, freshLoginRate: 1 }, async (api) => {
      const orders = expect(await api.get("/orders"), 200).data.items as any[];
      await think();
      if (!orders.length) return "completed";
      const order = pick(orders);
      expect(await api.get(`/orders/${order.id}`), 200);
      if (Math.random() < 0.3) {
        expect(await api.delete("/cart"), 200);
        for (const item of order.items) expect(await api.post("/cart/items", { productId: item.productId, quantity: item.quantity }), 201);
        return checkout(api);
      }
      return "completed";
    });
  },

  /** Clients that do things wrong. Each produces a specific 4xx and log line. */
  async misbehaving_client(ctx) {
    const anon = ctx.target.anonymous;
    const kind = pick(["garbage_token", "tampered_token", "wrong_password", "bad_payload", "unknown_product", "missing_token", "unknown_order"]);
    switch (kind) {
      case "garbage_token":
        expect(await anon.withToken("not-a-jwt").get("/cart"), 401);
        break;
      case "tampered_token": {
        // A real token whose payload was edited: the signature no longer matches.
        const token = (await withUser(ctx, async (a) => a)).token ?? "";
        const [h, p, s] = token.split(".");
        const payload = JSON.parse(Buffer.from(p, "base64url").toString());
        payload.roles = ["customer", "instructor"];
        expect(await anon.withToken(`${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`).get("/orders"), 401);
        break;
      }
      case "wrong_password":
        expect(await anon.post("/auth/oauth/token", { grant_type: "password", username: ctx.target.randomUsername(), password: "definitely-wrong" }), 401);
        break;
      case "bad_payload":
        await withUser(ctx, async (api) => expect(await api.post("/cart/items", { productId: "p001", quantity: -5 }), 400));
        break;
      case "unknown_product":
        expect(await anon.get(`/catalog/products/p999`), 404);
        break;
      case "missing_token":
        expect(await anon.get("/orders"), 401);
        break;
      case "unknown_order":
        await withUser(ctx, async (api) => expect(await api.get(`/orders/${randomUUID()}`), 404));
        break;
    }
    return "expected_error";
  },

  /** A bot replaying leaked credentials against the login endpoint, quickly. */
  async credential_stuffer(ctx) {
    const anon = ctx.target.anonymous;
    const attempts = between(8, 20);
    for (let i = 0; i < attempts; i++) {
      const username = Math.random() < 0.6 ? ctx.target.randomUsername() : pick(LEAKED_USERS);
      const res = await anon.post("/auth/oauth/token", { grant_type: "password", username, password: pick(LEAKED_PASSWORDS) });
      // Blocked by a rate limit at the ingress or gateway: the bot gives up on this address.
      if (res.status === 429 || res.status === 503) return "blocked";
      expect(res, 400, 401);
      await sleep(50 + Math.random() * 250);
    }
    return "expected_error";
  },
};

export const runJourney = (name: JourneyName, ctx: JourneyContext) => journeys[name](ctx);
