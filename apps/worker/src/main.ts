import { once } from "node:events";
import { loadTelemetryEnv, startTelemetry } from "@aoo/telemetry/sdk";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { createWorkerServices, runSweeps } from "./services.js";
import { createWorkerLoop } from "./worker.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.WORKER_ID);
// (M9) Opt-in tracing (OTEL_ENABLED=true). Best-effort: exports run in the background, and an
// unreachable collector never blocks or fails outbox processing.
const otel = loadTelemetryEnv();
const telemetry = startTelemetry({
  enabled: otel.OTEL_ENABLED,
  serviceName: otel.OTEL_SERVICE_NAME ?? "aoo-worker",
  endpoint: otel.OTEL_EXPORTER_OTLP_ENDPOINT,
});

// (M10) The same services as the bounded serverless worker; this process polls continuously.
const services = createWorkerServices(config, logger);
const { database, runner } = services;
const loop = createWorkerLoop({
  workerId: config.WORKER_ID,
  runner,
  batchSize: config.OUTBOX_BATCH_SIZE,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  logger,
});

const health = createHealthServer(loop.state, {
  stallAfterMs: Math.max(config.OUTBOX_LEASE_MS, config.OUTBOX_POLL_INTERVAL_MS * 5) + 30_000,
});
health.listen(config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST);
await once(health, "listening");
logger.info(
  {
    healthAddress: health.address(),
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    ...services.description,
    tracing: telemetry.enabled ? "enabled" : "disabled",
  },
  "worker configured",
);

const done = loop.run();

// M7C/M8 periodic reconciliation (de-duplicated wakes; execution goes through the outbox).
const sweep = () => runSweeps(services, logger);
const sweeper = setInterval(() => void sweep(), config.PROVISIONING_SWEEP_INTERVAL_MS);
void sweep();

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down: finishing in-flight batch");
  loop.stop();
  clearInterval(sweeper);
  const timeout = new Promise<"timeout">((r) =>
    setTimeout(() => r("timeout"), config.WORKER_SHUTDOWN_TIMEOUT_MS).unref(),
  );
  if ((await Promise.race([done.then(() => "done" as const), timeout])) === "timeout") {
    // Unfinished leases simply expire and another worker recovers those events.
    logger.warn({ timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS }, "shutdown timed out");
  }
  health.close();
  await telemetry.shutdown();
  await database.close();
  logger.info("worker stopped");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
