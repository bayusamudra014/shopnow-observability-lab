import { z } from "zod";

/** Kafka topic names. Every topic also has a `<name>.dlq` dead-letter topic. */
export const Topics = {
  OrderPlaced: "order.placed",
  OrderConfirmed: "order.confirmed",
  OrderCancelled: "order.cancelled",
  PaymentSucceeded: "payment.succeeded",
  PaymentFailed: "payment.failed",
} as const;
export type Topic = (typeof Topics)[keyof typeof Topics];
export const dlqOf = (topic: string) => `${topic}.dlq`;

export const OrderItem = z.object({
  productId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});
export type OrderItem = z.infer<typeof OrderItem>;

const envelope = {
  eventId: z.string().uuid(),
  occurredAt: z.string(),
};

export const OrderPlacedEvent = z.object({
  ...envelope,
  type: z.literal(Topics.OrderPlaced),
  orderId: z.string().uuid(),
  userId: z.string(),
  userEmail: z.string(),
  totalCents: z.number().int(),
  items: z.array(OrderItem),
});
export type OrderPlacedEvent = z.infer<typeof OrderPlacedEvent>;

export const OrderConfirmedEvent = z.object({
  ...envelope,
  type: z.literal(Topics.OrderConfirmed),
  orderId: z.string().uuid(),
  userId: z.string(),
  userEmail: z.string(),
  paymentId: z.string().uuid(),
  totalCents: z.number().int(),
});
export type OrderConfirmedEvent = z.infer<typeof OrderConfirmedEvent>;

export const OrderCancelledEvent = z.object({
  ...envelope,
  type: z.literal(Topics.OrderCancelled),
  orderId: z.string().uuid(),
  userId: z.string(),
  userEmail: z.string(),
  reason: z.string(),
});
export type OrderCancelledEvent = z.infer<typeof OrderCancelledEvent>;

export const PaymentSucceededEvent = z.object({
  ...envelope,
  type: z.literal(Topics.PaymentSucceeded),
  paymentId: z.string().uuid(),
  orderId: z.string().uuid(),
  amountCents: z.number().int(),
  providerChargeId: z.string(),
});
export type PaymentSucceededEvent = z.infer<typeof PaymentSucceededEvent>;

export const PaymentFailedEvent = z.object({
  ...envelope,
  type: z.literal(Topics.PaymentFailed),
  paymentId: z.string().uuid(),
  orderId: z.string().uuid(),
  amountCents: z.number().int(),
  reason: z.string(),
});
export type PaymentFailedEvent = z.infer<typeof PaymentFailedEvent>;

export const EventSchemas = {
  [Topics.OrderPlaced]: OrderPlacedEvent,
  [Topics.OrderConfirmed]: OrderConfirmedEvent,
  [Topics.OrderCancelled]: OrderCancelledEvent,
  [Topics.PaymentSucceeded]: PaymentSucceededEvent,
  [Topics.PaymentFailed]: PaymentFailedEvent,
} as const;

/** Product ids are shared between catalog and inventory seed data: p001 .. p024. */
export const productIds = Array.from({ length: 24 }, (_, i) => `p${String(i + 1).padStart(3, "0")}`);

/** Headers the api-gateway sets after verifying the JWT. Services trust only these. */
export const UserHeaders = {
  id: "x-user-id",
  email: "x-user-email",
  roles: "x-user-roles",
} as const;
