import {
  createOnboardingPlanAgent,
  createOnboardingPlanProviderFromConfig,
  createProviderFromConfig,
  createRoleAccessAgent,
  loadOnboardingPlanAgentConfig,
  loadRoleAccessAgentConfig,
} from "@aoo/agents";
import { loadCatalogRegistry } from "@aoo/catalog";
import { createDatabase, type DatabaseHandle } from "@aoo/db";
import { createGitHubClient } from "@aoo/github";
import { createOktaClient } from "@aoo/okta";
import {
  createAccessAuthorizationService,
  createAccessPlanningService,
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
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  type AccessPlanningService,
  type ExternalOperationHandler,
  type OnboardingPlanService,
  type OutboxRunner,
  type ProvisioningCoordinator,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import { createServiceNowClient, safeUrl } from "@aoo/servicenow";
import type pino from "pino";
import {
  loadWorkerProvisioningProviders,
  loadWorkerServiceNowConfig,
  type WorkerConfig,
} from "./config.js";

export interface WorkerServices {
  database: DatabaseHandle;
  runner: OutboxRunner;
  coordinator: ProvisioningCoordinator;
  onboardingPlans: OnboardingPlanService | undefined;
  accessPlanning: AccessPlanningService | undefined;
  /** Safe, value-free description of what is enabled (for the startup log). */
  description: Record<string, unknown>;
}

/**
 * Builds every worker service from configuration. Shared by the long-running Compose process
 * (main.ts) and the bounded Vercel Function (serverless.ts), so both run the same handlers.
 */
export function createWorkerServices(
  config: WorkerConfig,
  logger: pino.Logger,
  options: { maxConnections?: number; env?: NodeJS.ProcessEnv } = {},
): WorkerServices {
  const env = options.env ?? process.env;
  const database = createDatabase(config.DATABASE_URL, {
    maxConnections: options.maxConnections ?? Math.min(50, config.OUTBOX_BATCH_SIZE * 2 + 2),
    onIdleClientError: (err) => logger.warn({ err: err.message }, "database idle connection lost"),
  });
  const servicenowConfig = loadWorkerServiceNowConfig(config, env);
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
  const providers = loadWorkerProvisioningProviders(env);
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
        const agentConfig = loadOnboardingPlanAgentConfig(env); // names a missing variable only
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
  // M10: automatic access planning (Role Access Agent → policy authorization), when enabled.
  const accessPlanning = config.ROLE_ACCESS_AGENT_ENABLED
    ? (() => {
        const agentConfig = loadRoleAccessAgentConfig(env); // names a missing variable only
        return createAccessPlanningService(database.db, {
          recommendations: createRoleAccessRecommendationService(database.db, {
            agent: createRoleAccessAgent({
              provider: createProviderFromConfig(agentConfig),
              maxAttempts: agentConfig.ROLE_ACCESS_AGENT_MAX_ATTEMPTS,
            }),
            catalogs,
            ownerId: config.WORKER_ID,
            leaseMs: config.ROLE_ACCESS_RUN_LEASE_MS,
            logger,
          }),
          authorization: createAccessAuthorizationService(database.db, {
            policies: loadPolicyRegistry(catalogs),
            catalogs,
            workflows,
            externalOperations,
          }),
          workflows,
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
      ...(accessPlanning && { accessPlanning }),
    }),
    logger,
  });

  return {
    database,
    runner,
    coordinator,
    onboardingPlans,
    accessPlanning,
    description: {
      batchSize: config.OUTBOX_BATCH_SIZE,
      leaseMs: config.OUTBOX_LEASE_MS,
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
      roleAccessAgent: accessPlanning ? "enabled" : "disabled",
      servicenow: servicenowConfig
        ? {
            instance: safeUrl(new URL(servicenowConfig.instanceUrl)),
            timeoutMs: servicenowConfig.timeoutMs,
            table: servicenowConfig.accessRequestTable,
          }
        : "disabled",
    },
  };
}

/**
 * M7C/M8 periodic reconciliation: enqueue de-duplicated wakes for due provisioning work and
 * onboarding-plan recovery. Execution still goes through the outbox. Never throws.
 */
export async function runSweeps(
  services: Pick<WorkerServices, "coordinator" | "onboardingPlans"> &
    Partial<Pick<WorkerServices, "accessPlanning">>,
  logger: Pick<pino.Logger, "info" | "warn">,
): Promise<{ wakes: number; planRequests: number; accessPlanning: number; failed: boolean }> {
  let wakes = 0;
  let planRequests = 0;
  let accessPlanning = 0;
  try {
    // M10 recovery: started workflows whose access planning request was missed or disabled.
    if (services.accessPlanning) {
      accessPlanning = (await services.accessPlanning.enqueueDuePlanning()).enqueued;
      if (accessPlanning > 0) {
        logger.info({ enqueued: accessPlanning }, "access planning requests enqueued");
      }
    }
    wakes = (await services.coordinator.enqueueDueWakes()).enqueued;
    if (wakes > 0) logger.info({ enqueued: wakes }, "provisioning reconciliation wakes enqueued");
    // M8 recovery: workflows in ONBOARDING_GENERATION without an accepted plan (missed event).
    if (services.onboardingPlans) {
      planRequests = (await services.onboardingPlans.enqueueDueGenerations()).enqueued;
      if (planRequests > 0) {
        logger.info({ enqueued: planRequests }, "onboarding plan generation requests enqueued");
      }
    }
    return { wakes, planRequests, accessPlanning, failed: false };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "provisioning sweep failed",
    );
    return { wakes, planRequests, accessPlanning, failed: true };
  }
}
