import { hostname } from "node:os";
import { loadGitHubConfig, loadGitHubTargets } from "@aoo/github";
import { loadOktaConfig, loadOktaGroupTargets } from "@aoo/okta";
import { loadServiceNowConfig, type ServiceNowConfig } from "@aoo/servicenow";
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
    EXTERNAL_OP_RECONCILE_ATTEMPTS: int(1, 10, 3),
    EXTERNAL_OP_RECONCILE_DELAY_MS: int(0, 30_000, 1000),
    // M7C provisioning orchestration.
    /** How often the reconciler looks for due provisioning work (wakes are de-duplicated per bucket). */
    PROVISIONING_SWEEP_INTERVAL_MS: int(1000, 3_600_000, 60_000),
    /** How long to wait before re-reading an external waiting state (e.g. a GitHub invitation). */
    PROVISIONING_RECONCILE_INTERVAL_MS: int(1000, 86_400_000, 300_000),
    /** Delay before retrying a transient provider failure. */
    PROVISIONING_RETRY_DELAY_MS: int(1000, 86_400_000, 60_000),
    /**
     * (M7D) Create ServiceNow fulfillment records for authorized SERVICENOW resources. Off by
     * default: ordinary Compose never writes fulfillment tickets unless explicitly enabled.
     */
    PROVISIONING_SERVICENOW_FULFILLMENT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** (M7D) Re-read delay for a pending ServiceNow fulfillment (lost-callback safety net). */
    PROVISIONING_FULFILLMENT_RECONCILE_INTERVAL_MS: int(10_000, 86_400_000, 120_000),
    /**
     * (M8) Generate onboarding plans with the Onboarding Plan Agent (OpenAI). Off by default:
     * ordinary Compose never calls OpenAI unless explicitly enabled. Requires OPENAI_API_KEY.
     */
    ONBOARDING_PLAN_GENERATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** (M8) Lease on one plan-generation run; the model deadline is 80% of it. */
    ONBOARDING_PLAN_RUN_LEASE_MS: int(10_000, 3_600_000, 180_000),
    /**
     * (M10) Run the Role Access Agent (OpenAI) and the policy authorization automatically on
     * access.planning.requested. Off by default: Compose never calls OpenAI unless enabled.
     * Requires OPENAI_API_KEY.
     */
    ROLE_ACCESS_AGENT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** (M10) Lease on one Role Access run; the model deadline is 80% of it. */
    ROLE_ACCESS_RUN_LEASE_MS: int(10_000, 3_600_000, 180_000),
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

/**
 * (M10) The bounded serverless worker (Vercel Function invoked by a signed QStash schedule).
 * Only the two signing keys are needed to authenticate deliveries: QSTASH_TOKEN (schedule
 * management) is deliberately not part of the runtime configuration.
 */
const FunctionEnvSchema = z.object({
  QSTASH_CURRENT_SIGNING_KEY: z.string().trim().min(16, "QSTASH_CURRENT_SIGNING_KEY is required"),
  QSTASH_NEXT_SIGNING_KEY: z.string().trim().min(16, "QSTASH_NEXT_SIGNING_KEY is required"),
  /** The exact public URL QStash delivers to; verified against the signature's subject. */
  WORKER_QSTASH_URL: z.url({ protocol: /^https$/ }),
  /** Platform limit of the function (Vercel Hobby: 300 s). */
  WORKER_FUNCTION_MAX_DURATION_MS: int(10_000, 900_000, 300_000),
  /** Stop claiming new work after this long; in-flight handlers then finish. */
  WORKER_RUN_DEADLINE_MS: int(1_000, 900_000, 230_000),
  /** Upper bound of events claimed in one invocation. */
  WORKER_RUN_MAX_EVENTS: int(1, 10_000, 500),
});
export type WorkerFunctionConfig = z.infer<typeof FunctionEnvSchema>;

/** Margin for sweeps, acknowledgement and connection teardown after the last handler. */
export const FUNCTION_SAFETY_MARGIN_MS = 10_000;

/**
 * Longest a single claimed event can take: a coordination stops dispatching at half the lease
 * and its in-flight provider operation is bounded by 0.8 × the lease; a plan-generation or
 * Role Access model call is bounded by 0.8 × its run lease.
 */
export function maxHandlerMs(config: WorkerConfig): number {
  return Math.max(
    Math.ceil(config.OUTBOX_LEASE_MS * (0.5 + EXTERNAL_CALL_LEASE_FRACTION)),
    Math.ceil(config.ONBOARDING_PLAN_RUN_LEASE_MS * 0.8),
    Math.ceil(config.ROLE_ACCESS_RUN_LEASE_MS * 0.8),
  );
}

/** Errors name variables only, never values. Refuses a deadline that could outlive the platform. */
export function loadWorkerFunctionConfig(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): WorkerFunctionConfig {
  const parsed = FunctionEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid worker function configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const fn = parsed.data;
  const worstCase = fn.WORKER_RUN_DEADLINE_MS + maxHandlerMs(config) + FUNCTION_SAFETY_MARGIN_MS;
  if (worstCase > fn.WORKER_FUNCTION_MAX_DURATION_MS) {
    throw new Error(
      `WORKER_RUN_DEADLINE_MS (${fn.WORKER_RUN_DEADLINE_MS}) + longest handler (${maxHandlerMs(config)}) + margin ` +
        `exceeds WORKER_FUNCTION_MAX_DURATION_MS (${fn.WORKER_FUNCTION_MAX_DURATION_MS}); ` +
        "lower the deadline, OUTBOX_LEASE_MS or ONBOARDING_PLAN_RUN_LEASE_MS.",
    );
  }
  return fn;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return EnvSchema.parse(env);
}

/** Share of the worker lease an external operation may spend calling the provider. */
export const EXTERNAL_CALL_LEASE_FRACTION = 0.8;
/** Provider calls on the happy path of one attempt: pre-create lookup, create, read-back. */
export const EXTERNAL_CALLS_PER_ATTEMPT = 3;

/**
 * ServiceNow is optional for the worker. Uses ONLY the integration account (loadServiceNowConfig);
 * schema-verification credentials are never read here.
 *
 * Invariant: EXTERNAL_CALLS_PER_ATTEMPT × SERVICENOW_TIMEOUT_MS ≤ EXTERNAL_CALL_LEASE_FRACTION ×
 * OUTBOX_LEASE_MS. The executor additionally enforces a hard deadline of that same fraction of
 * the lease on every provider call (including retries and reconciliation), so no call outlives
 * the lease even when this inequality is only barely met.
 */
export function loadWorkerServiceNowConfig(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): ServiceNowConfig | null {
  if (!env.SERVICENOW_INSTANCE_URL?.trim()) return null;
  const sn = loadServiceNowConfig(env);
  const budget = Math.floor(config.OUTBOX_LEASE_MS * EXTERNAL_CALL_LEASE_FRACTION);
  if (EXTERNAL_CALLS_PER_ATTEMPT * sn.timeoutMs > budget) {
    throw new Error(
      `SERVICENOW_TIMEOUT_MS (${sn.timeoutMs}) is too long for OUTBOX_LEASE_MS (${config.OUTBOX_LEASE_MS}): ` +
        `${EXTERNAL_CALLS_PER_ATTEMPT} × timeout must be ≤ ${budget} ms. Lower the timeout or raise the lease.`,
    );
  }
  return sn;
}

/**
 * M7C: optional provisioning providers. Each is enabled only when its token is set; resources of
 * an unconfigured provider are blocked visibly (PROVIDER_NOT_CONFIGURED), never skipped.
 */
export function loadWorkerProvisioningProviders(env: NodeJS.ProcessEnv = process.env) {
  return {
    okta: env.OKTA_API_TOKEN?.trim()
      ? { config: loadOktaConfig(env), targets: loadOktaGroupTargets(env) }
      : undefined,
    github: env.GITHUB_TOKEN?.trim()
      ? { config: loadGitHubConfig(env), targets: loadGitHubTargets(env) }
      : undefined,
  };
}
