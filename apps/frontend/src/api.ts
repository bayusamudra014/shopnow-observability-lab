import { accessToken, refresh } from "./session";

/** Error from the API. `requestId` is the x-request-id: search for it in SigNoz logs. */
export class ApiError extends Error {
  status: number;
  requestId?: string;
  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * Random UUID v4. crypto.randomUUID() only exists on secure origins (https or localhost),
 * and the shop is served over plain http://shop.local, so build it from getRandomValues,
 * which works everywhere.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const send = async () => {
    const token = await accessToken();
    return fetch(`/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  let res = await send();
  if (res.status === 401 && (await accessToken())) {
    await refresh();
    res = await send();
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? data?.error ?? res.statusText, res.headers.get("x-request-id") ?? undefined);
  return data as T;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  emoji: string;
  priceCents: number;
  rating?: { average: number | null; count: number };
  reviews?: { rating: number; comment: string; createdAt: string }[];
}

export interface CartItem {
  productId: string;
  name: string;
  emoji: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}
export interface Cart {
  items: CartItem[];
  itemCount: number;
  totalCents: number;
}

export interface Order {
  id: string;
  status: "created" | "awaiting_payment" | "confirmed" | "cancelled";
  totalCents: number;
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
  paymentId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
