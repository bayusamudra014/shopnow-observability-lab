/**
 * OpenTelemetry bootstrap. Loaded BEFORE the application with:
 *   node --require @shop/telemetry/register dist/main.js
 *
 * Everything (exporters, endpoint, service name, resource attributes) is configured
 * through the standard OTEL_* environment variables, e.g.
 *   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL,
 *   OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER, OTEL_RESOURCE_ATTRIBUTES
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const quietPaths = new Set(["/health", "/ready", "/metrics"]);

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      // These produce a lot of low-value spans; turn them off to keep traces readable.
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (req) => quietPaths.has((req.url ?? "").split("?")[0]),
      },
    }),
  ],
});

sdk.start();
(globalThis as { __shopOtelSdk?: NodeSDK }).__shopOtelSdk = sdk;
