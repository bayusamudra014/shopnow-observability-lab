import pino from "pino";

/**
 * Structured JSON logger. The OpenTelemetry pino instrumentation automatically adds
 * trace_id / span_id / trace_flags to every log written inside an active span, and
 * (when OTEL_LOGS_EXPORTER=otlp) also ships each record to the collector over OTLP.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.OTEL_SERVICE_NAME ?? "unknown" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: ["password", "*.password", "authorization", "*.authorization"], censor: "[redacted]" },
});

export type Logger = typeof logger;
