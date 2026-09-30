import { loadTelemetryEnv, startTelemetry } from "@aoo/telemetry/sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
// (M9) Opt-in tracing (OTEL_ENABLED=true); best-effort, never required for correctness.
const otel = loadTelemetryEnv();
const telemetry = startTelemetry({
  enabled: otel.OTEL_ENABLED,
  serviceName: otel.OTEL_SERVICE_NAME ?? "aoo-api",
  endpoint: otel.OTEL_EXPORTER_OTLP_ENDPOINT,
});
const app = await buildApp(config);
app.addHook("onClose", () => telemetry.shutdown());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
