import { hostname } from "node:os";
import { z } from "zod";

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    WORKER_ID: z.string().trim().min(1).max(200).default(`${hostname()}-${process.pid}`),
    WORKER_HEALTH_HOST: z.string().default("0.0.0.0"),
    WORKER_HEALTH_PORT: int(0, 65_535, 4100),
    WORKER_SHUTDOWN_TIMEOUT_MS: int(0, 300_000, 15_000),
    OUTBOX_BATCH_SIZE: int(1, 100, 10),
    OUTBOX_POLL_INTERVAL_MS: int(10, 60_000, 1000),
    OUTBOX_LEASE_MS: int(100, 3_600_000, 30_000),
    OUTBOX_MAX_ATTEMPTS: int(1, 100, 5),
    OUTBOX_BACKOFF_BASE_MS: int(1, 3_600_000, 1000),
    OUTBOX_BACKOFF_MAX_MS: int(1, 86_400_000, 300_000),
  })
  .refine((c) => c.OUTBOX_BACKOFF_MAX_MS >= c.OUTBOX_BACKOFF_BASE_MS, {
    message: "OUTBOX_BACKOFF_MAX_MS must be >= OUTBOX_BACKOFF_BASE_MS",
    path: ["OUTBOX_BACKOFF_MAX_MS"],
  })
  .refine((c) => c.OUTBOX_LEASE_MS > c.OUTBOX_POLL_INTERVAL_MS, {
    message: "OUTBOX_LEASE_MS must exceed OUTBOX_POLL_INTERVAL_MS",
    path: ["OUTBOX_LEASE_MS"],
  });

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return EnvSchema.parse(env);
}
