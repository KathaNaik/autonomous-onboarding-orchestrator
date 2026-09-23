import { once } from "node:events";
import { createDatabase } from "@aoo/db";
import {
  createEventHandlers,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
} from "@aoo/orchestrator";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { createWorkerLoop } from "./worker.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.WORKER_ID);

const database = createDatabase(config.DATABASE_URL, {
  maxConnections: Math.min(50, config.OUTBOX_BATCH_SIZE * 2 + 2),
});
const runner = createOutboxRunner(createPostgresOutboxStore(database.db), {
  workerId: config.WORKER_ID,
  batchSize: config.OUTBOX_BATCH_SIZE,
  leaseMs: config.OUTBOX_LEASE_MS,
  retry: {
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: config.OUTBOX_BACKOFF_BASE_MS,
    backoffMaxMs: config.OUTBOX_BACKOFF_MAX_MS,
  },
  handlers: createEventHandlers({ workflows: createWorkflowService(database.db) }),
  logger,
});
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
    batchSize: config.OUTBOX_BATCH_SIZE,
    leaseMs: config.OUTBOX_LEASE_MS,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: config.OUTBOX_BACKOFF_BASE_MS,
    backoffMaxMs: config.OUTBOX_BACKOFF_MAX_MS,
  },
  "worker configured",
);

const done = loop.run();

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down: finishing in-flight batch");
  loop.stop();
  const timeout = new Promise<"timeout">((r) =>
    setTimeout(() => r("timeout"), config.WORKER_SHUTDOWN_TIMEOUT_MS).unref(),
  );
  if ((await Promise.race([done.then(() => "done" as const), timeout])) === "timeout") {
    // Unfinished leases simply expire and another worker recovers those events.
    logger.warn({ timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS }, "shutdown timed out");
  }
  health.close();
  await database.close();
  logger.info("worker stopped");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
