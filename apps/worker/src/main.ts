import { once } from "node:events";
import {
  createOnboardingPlanAgent,
  createOnboardingPlanProviderFromConfig,
  loadOnboardingPlanAgentConfig,
} from "@aoo/agents";
import { loadCatalogRegistry } from "@aoo/catalog";
import { createDatabase } from "@aoo/db";
import { createGitHubClient } from "@aoo/github";
import { createOktaClient } from "@aoo/okta";
import {
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubProvisioningService,
  createOnboardingPlanService,
  createOktaHandlers,
  createOktaProvisioningService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  type ExternalOperationHandler,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import { createServiceNowClient, safeUrl } from "@aoo/servicenow";
import {
  loadConfig,
  loadWorkerProvisioningProviders,
  loadWorkerServiceNowConfig,
} from "./config.js";
import { createHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { createWorkerLoop } from "./worker.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.WORKER_ID);

const database = createDatabase(config.DATABASE_URL, {
  maxConnections: Math.min(50, config.OUTBOX_BATCH_SIZE * 2 + 2),
  onIdleClientError: (err) => logger.warn({ err: err.message }, "database idle connection lost"),
});
const servicenowConfig = loadWorkerServiceNowConfig(config);
const servicenow = servicenowConfig
  ? createServiceNowClient(servicenowConfig, { logger: logger.child({ provider: "servicenow" }) })
  : undefined;
const workflows = createWorkflowService(database.db);
// Approval callbacks are verified by reading the ticket back with the integration account.
const approvals = createApprovalService(database.db, {
  ...(servicenow && { servicenow }),
  workflows,
  logger,
});
// M7C: provider clients are optional; unconfigured providers block their resources visibly.
const providers = loadWorkerProvisioningProviders();
const okta = providers.okta && {
  client: createOktaClient(providers.okta.config, { logger: logger.child({ provider: "okta" }) }),
  targets: providers.okta.targets,
};
const github = providers.github && {
  client: createGitHubClient(providers.github.config, {
    logger: logger.child({ provider: "github" }),
  }),
  targets: providers.github.targets,
};
// M7D: ServiceNow fulfillment only when explicitly enabled AND ServiceNow is configured.
const fulfillment = config.PROVISIONING_SERVICENOW_FULFILLMENT_ENABLED ? servicenow : undefined;
const handlers: ExternalOperationHandler[] = [
  ...(fulfillment ? [createServiceNowFulfillmentHandler(fulfillment)] : []),
  ...(okta ? createOktaHandlers(okta.client) : []),
  ...(github ? createGitHubHandlers(github.client) : []),
];
const externalOperations = createExternalOperationService(database.db, {
  ...(servicenow && { servicenow }),
  handlers,
  reconcile: {
    attempts: config.EXTERNAL_OP_RECONCILE_ATTEMPTS,
    delayMs: config.EXTERNAL_OP_RECONCILE_DELAY_MS,
  },
  logger,
});
const catalogs = loadCatalogRegistry();
const provisionerOwner = { ownerId: config.WORKER_ID, leaseMs: config.OUTBOX_LEASE_MS };
const coordinator = createProvisioningCoordinator(database.db, {
  catalogs,
  workflows,
  ...(okta && {
    okta: createOktaProvisioningService(database.db, {
      catalogs,
      externalOperations,
      okta: okta.client,
      targets: okta.targets,
      ...provisionerOwner,
      logger,
    }),
  }),
  ...(github && {
    github: createGitHubProvisioningService(database.db, {
      catalogs,
      externalOperations,
      github: github.client,
      targets: github.targets,
      ...provisionerOwner,
      logger,
    }),
  }),
  ...(fulfillment && {
    servicenow: createServiceNowFulfillmentService(database.db, {
      catalogs,
      externalOperations,
      servicenow: fulfillment,
      ...provisionerOwner,
      logger,
    }),
  }),
  reconcileIntervalMs: config.PROVISIONING_RECONCILE_INTERVAL_MS,
  fulfillmentReconcileIntervalMs: config.PROVISIONING_FULFILLMENT_RECONCILE_INTERVAL_MS,
  retryDelayMs: config.PROVISIONING_RETRY_DELAY_MS,
  sweepIntervalMs: config.PROVISIONING_SWEEP_INTERVAL_MS,
  // Start no new dispatch after half the lease; the rest continues in a fresh wake.
  deadlineMs: Math.floor(config.OUTBOX_LEASE_MS / 2),
  logger,
});
// M8: the Onboarding Plan Agent runs only when explicitly enabled (it calls OpenAI).
const onboardingPlans = config.ONBOARDING_PLAN_GENERATION_ENABLED
  ? (() => {
      const agentConfig = loadOnboardingPlanAgentConfig(); // names a missing variable, never a value
      return createOnboardingPlanService(database.db, {
        agent: createOnboardingPlanAgent({
          provider: createOnboardingPlanProviderFromConfig(agentConfig),
          maxAttempts: agentConfig.ONBOARDING_PLAN_AGENT_MAX_ATTEMPTS,
        }),
        catalogs,
        policies: loadPolicyRegistry(catalogs),
        workflows,
        ownerId: config.WORKER_ID,
        leaseMs: config.ONBOARDING_PLAN_RUN_LEASE_MS,
        sweepIntervalMs: config.PROVISIONING_SWEEP_INTERVAL_MS,
        logger,
      });
    })()
  : undefined;
const runner = createOutboxRunner(createPostgresOutboxStore(database.db), {
  workerId: config.WORKER_ID,
  batchSize: config.OUTBOX_BATCH_SIZE,
  leaseMs: config.OUTBOX_LEASE_MS,
  retry: {
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: config.OUTBOX_BACKOFF_BASE_MS,
    backoffMaxMs: config.OUTBOX_BACKOFF_MAX_MS,
  },
  handlers: createEventHandlers({
    workflows,
    approvals,
    externalOperations: {
      service: externalOperations,
      ownerId: config.WORKER_ID,
      leaseMs: config.OUTBOX_LEASE_MS,
    },
    provisioning: coordinator,
    ...(onboardingPlans && { onboardingPlans }),
  }),
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
    provisioning: {
      okta: okta ? "enabled" : "disabled",
      github: github ? "enabled" : "disabled",
      servicenowFulfillment: fulfillment ? "enabled" : "disabled",
      sweepIntervalMs: config.PROVISIONING_SWEEP_INTERVAL_MS,
      reconcileIntervalMs: config.PROVISIONING_RECONCILE_INTERVAL_MS,
    },
    onboardingPlanGeneration: onboardingPlans ? "enabled" : "disabled",
    servicenow: servicenowConfig
      ? {
          instance: safeUrl(new URL(servicenowConfig.instanceUrl)),
          timeoutMs: servicenowConfig.timeoutMs,
          table: servicenowConfig.accessRequestTable,
        }
      : "disabled",
  },
  "worker configured",
);

const done = loop.run();

// M7C periodic reconciliation: enqueue de-duplicated wakes for due provisioning work (e.g. a
// pending GitHub invitation the employee may have accepted). Execution goes through the outbox.
const sweep = async () => {
  try {
    const { enqueued } = await coordinator.enqueueDueWakes();
    if (enqueued > 0) logger.info({ enqueued }, "provisioning reconciliation wakes enqueued");
    // M8 recovery: workflows in ONBOARDING_GENERATION without an accepted plan (e.g. a missed event).
    if (onboardingPlans) {
      const plans = await onboardingPlans.enqueueDueGenerations();
      if (plans.enqueued > 0) logger.info(plans, "onboarding plan generation requests enqueued");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "provisioning sweep failed",
    );
  }
};
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
  await database.close();
  logger.info("worker stopped");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
