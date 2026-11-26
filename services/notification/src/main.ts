/**
 * notification: consumes order events and sends emails over SMTP to Mailpit
 * (a fake mail server with a web inbox, see http://mail.local).
 *
 * Knobs for labs (env vars, or PUT /admin/config at runtime):
 *   NOTIFICATION_DELAY_MS       extra latency before each send -> consumer lag grows
 *   NOTIFICATION_FAILURE_RATE   0..1 chance a send fails       -> retries, then the DLQ
 * Stopping Mailpit (kubectl scale deploy/mailpit -n infra --replicas=0) produces real
 * SMTP connection errors.
 */
import nodemailer from "nodemailer";
import { z } from "zod";
import { Topics } from "@shop/contracts";
import { createServer, start, createKafka, runConsumer, logger, metrics, trace, sleep, env, envNumber, SpanStatusCode } from "@shop/telemetry";

const PORT = envNumber("PORT", 8080);
const FROM = env("MAIL_FROM", "ShopNow <no-reply@shopnow.local>");
const SHOP_URL = env("SHOP_PUBLIC_URL", "http://shop.local");
const config = {
  delayMs: envNumber("NOTIFICATION_DELAY_MS", 0),
  failureRate: envNumber("NOTIFICATION_FAILURE_RATE", 0),
};

const SMTP_HOST = env("SMTP_HOST", "mailpit.infra");
const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: envNumber("SMTP_PORT", 1025),
  secure: false,
  ignoreTLS: true,
  connectionTimeout: 5000,
  socketTimeout: 10_000,
});

const tracer = trace.getTracer("notification");
const meter = metrics.getMeter("notification");
const sent = meter.createCounter("shop_notifications_sent_total", { description: "Emails sent by template and result" });

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const short = (id: string) => id.slice(0, 8);

const templates: Record<string, (e: any) => { subject: string; html: string }> = {
  [Topics.OrderPlaced]: (e) => ({
    subject: `We received your order ${short(e.orderId)}`,
    html: `<h2>Thanks for your order!</h2>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
        ${e.items.map((i: any) => `<tr><td>${i.name}</td><td>${i.quantity}</td><td>${money(i.unitPriceCents * i.quantity)}</td></tr>`).join("")}
      </table>
      <p><b>Total: ${money(e.totalCents)}</b></p>
      <p>We are waiting for the payment provider to confirm your payment.</p>
      <p><a href="${SHOP_URL}/orders/${e.orderId}">View order</a></p>`,
  }),
  [Topics.OrderConfirmed]: (e) => ({
    subject: `Order ${short(e.orderId)} is confirmed`,
    html: `<h2>Payment received</h2><p>Your payment of <b>${money(e.totalCents)}</b> was successful and your order is confirmed.</p>
      <p><a href="${SHOP_URL}/orders/${e.orderId}">View order</a></p>`,
  }),
  [Topics.OrderCancelled]: (e) => ({
    subject: `Order ${short(e.orderId)} was cancelled`,
    html: `<h2>Your order was cancelled</h2><p>Reason: <code>${e.reason}</code></p><p>Any reserved stock has been released.</p>`,
  }),
};

async function sendEmail(to: string, subject: string, html: string, topic: string, orderId: string) {
  await tracer.startActiveSpan(
    "smtp.send",
    { attributes: { "email.template": topic, "email.to_domain": to.split("@")[1] ?? "", "server.address": SMTP_HOST } },
    async (span) => {
      try {
        if (config.delayMs) await sleep(config.delayMs);
        if (Math.random() < config.failureRate) throw new Error("SMTP 451 temporary failure (simulated)");
        const info = await transport.sendMail({
          from: FROM,
          to,
          subject,
          html,
          headers: { "X-Order-Id": orderId, "X-Trace-Id": span.spanContext().traceId },
        });
        span.setAttribute("email.message_id", info.messageId);
        sent.add(1, { template: topic, result: "sent" });
        logger.info({ to, subject, orderId, messageId: info.messageId }, `email "${subject}" sent to ${to}`);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        sent.add(1, { template: topic, result: "failed" });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

const app = createServer({ ready: async () => void (await transport.verify()) });

app.get("/admin/config", async () => config);
app.put("/admin/config", async (req) => {
  const next = z.object({ delayMs: z.number().int().min(0).max(60_000).optional(), failureRate: z.number().min(0).max(1).optional() }).parse(req.body);
  Object.assign(config, next);
  logger.warn({ config }, `notification config changed: delay ${config.delayMs} ms, failure rate ${Math.round(config.failureRate * 100)}%`);
  return config;
});

async function main() {
  const kafka = createKafka("notification");
  const consumer = await runConsumer({
    kafka,
    groupId: "notification",
    topics: [Topics.OrderPlaced, Topics.OrderConfirmed, Topics.OrderCancelled],
    handler: async (topic, event) => {
      const t = templates[topic];
      if (!t) return;
      trace.getActiveSpan()?.setAttribute("order.id", event.orderId);
      const { subject, html } = t(event);
      await sendEmail(event.userEmail, subject, html, topic, event.orderId);
    },
  });
  await start(app, PORT, [() => consumer.disconnect(), () => transport.close()]);
}

main().catch((err) => {
  logger.fatal({ err }, "notification failed to start");
  process.exit(1);
});
