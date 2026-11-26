import { Kafka, KafkaMessage, logLevel, Producer, IHeaders } from "kafkajs";
import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";
import { logger } from "./logger.js";
import { envNumber, retry, sleep } from "./util.js";

const meter = metrics.getMeter("shop.kafka");
const consumed = meter.createCounter("shop_kafka_messages_consumed_total", {
  description: "Kafka messages processed, by topic and outcome (ok, retried, dlq)",
});
const published = meter.createCounter("shop_kafka_messages_published_total", {
  description: "Kafka messages published, by topic",
});

const levelMap: Record<number, "error" | "warn" | "info" | "debug"> = {
  [logLevel.ERROR]: "error",
  [logLevel.WARN]: "warn",
  [logLevel.INFO]: "info",
  [logLevel.DEBUG]: "debug",
};

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    logLevel: logLevel.WARN,
    retry: { retries: 10, initialRetryTime: 500 },
    logCreator:
      () =>
      ({ level, log }) => {
        const { message, ...rest } = log;
        logger[levelMap[level] ?? "info"]({ kafka: rest }, `kafkajs: ${message}${rest.error ? `: ${String(rest.error)}` : ""}`);
      },
  });
}

// The v2 partitioner notice is printed by every producer at startup; it is noise here.
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= "1";

export async function connectProducer(kafka: Kafka): Promise<Producer> {
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await retry("kafka producer", () => producer.connect());
  return producer;
}

export async function publish(producer: Producer, topic: string, key: string, payload: unknown, headers?: IHeaders) {
  await producer.send({ topic, messages: [{ key, value: JSON.stringify(payload), headers }] });
  published.add(1, { topic });
}

export type Handler = (topic: string, payload: any, message: KafkaMessage) => Promise<void>;

export interface ConsumerOptions {
  kafka: Kafka;
  groupId: string;
  topics: string[];
  handler: Handler;
  /** Attempts before the message is sent to `<topic>.dlq`. */
  maxAttempts?: number;
}

/**
 * Consume topics with in-process retries and a dead-letter topic. The kafkajs
 * OpenTelemetry instrumentation continues the producer's trace for each message, so
 * logs written in `handler` carry the original checkout trace id.
 */
export async function runConsumer(opts: ConsumerOptions): Promise<{ disconnect: () => Promise<void> }> {
  const maxAttempts = opts.maxAttempts ?? envNumber("KAFKA_MAX_ATTEMPTS", 3);
  const consumer = opts.kafka.consumer({ groupId: opts.groupId });
  const dlq = opts.kafka.producer();
  await retry("kafka consumer", async () => {
    await consumer.connect();
    await dlq.connect();
  });
  for (const topic of opts.topics) await consumer.subscribe({ topic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const raw = message.value?.toString() ?? "";
      for (let attempt = 1; ; attempt++) {
        try {
          await opts.handler(topic, JSON.parse(raw), message);
          consumed.add(1, { topic, outcome: attempt === 1 ? "ok" : "retried" });
          return;
        } catch (err) {
          const e = err as Error;
          trace.getActiveSpan()?.recordException(e);
          if (attempt >= maxAttempts) {
            trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            logger.error({ err: e, topic, partition, offset: message.offset, attempt }, `${topic} message failed ${attempt} times, moved to ${topic}.dlq: ${e.message}`);
            await dlq.send({
              topic: `${topic}.dlq`,
              messages: [
                {
                  key: message.key,
                  value: message.value,
                  headers: { ...message.headers, "x-error": e.message, "x-original-topic": topic },
                },
              ],
            });
            consumed.add(1, { topic, outcome: "dlq" });
            return;
          }
          logger.warn({ err: e.message, topic, offset: message.offset, attempt }, `${topic} message failed (attempt ${attempt}), retrying: ${e.message}`);
          await sleep(200 * 2 ** attempt);
        }
      }
    },
  });
  return {
    disconnect: async () => {
      await consumer.disconnect();
      await dlq.disconnect();
    },
  };
}
