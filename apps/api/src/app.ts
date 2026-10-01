import { loadCatalogRegistry, type ResourceCatalog } from "@aoo/catalog";
import { createDatabase } from "@aoo/db";
import {
  createApprovalService,
  createGitHubIdentityService,
  createManualProvisioningService,
  createOperatorSessionService,
  createServiceNowFulfillmentCallbackService,
  createHrisIntakeService,
  createWorkflowReadService,
  createWorkflowService,
  type ApprovalService,
  type GitHubIdentityService,
  type ManualProvisioningService,
  type OperatorSessionService,
  type ServiceNowFulfillmentCallbackService,
  type HrisIntakeService,
  type WorkflowReadService,
} from "@aoo/orchestrator";
import { logTraceFields } from "@aoo/telemetry";
import Fastify, { type FastifyInstance } from "fastify";
import { callbackConfig, type Config } from "./config.js";
import { normalizeRequestId, registerRequestObservability } from "./observability.js";
import { adminOnboardingReadRoutes } from "./routes/admin-onboarding-read.js";
import { adminGitHubIdentityRoutes } from "./routes/admin-github-identity.js";
import { adminManualProvisioningRoutes } from "./routes/admin-manual-provisioning.js";
import { adminOperatorSessionRoutes } from "./routes/admin-operator-sessions.js";
import { healthRoutes } from "./routes/health.js";
import { hrisWebhookRoutes } from "./routes/hris-webhook.js";
import { resourceRoutes } from "./routes/resources.js";
import { serviceNowApprovalWebhookRoutes } from "./routes/servicenow-approval-webhook.js";
import { serviceNowFulfillmentWebhookRoutes } from "./routes/servicenow-fulfillment-webhook.js";

export interface AppDependencies {
  hrisIntake: HrisIntakeService;
  /** Records approval callbacks only; the API never reads ServiceNow or decides approvals. */
  approvals: ApprovalService;
  /** Current resource catalog version (read-only). */
  catalog: ResourceCatalog;
  /** (M7B) HR-recorded GitHub identity claims: records claims only, never provisions. */
  githubIdentities: GitHubIdentityService;
  /** (M7C) Operator confirmation of authorized provider=MANUAL resources. */
  manualProvisioning: ManualProvisioningService;
  /** (M7D) Records fulfillment notifications only; the worker reads ServiceNow and decides. */
  fulfillmentCallbacks: ServiceNowFulfillmentCallbackService;
  /** (M9) Read-only operator read models (dashboard). */
  workflowReads: WorkflowReadService;
  /** (M10) Server-side logout for dashboard sessions. */
  operatorSessions: OperatorSessionService;
}

/**
 * Builds the app without listening. Dependencies default to real, database-backed services;
 * unit tests may override them. The pg pool connects lazily, so building never touches the DB.
 */
export async function buildApp(
  config: Config,
  overrides: Partial<AppDependencies> = {},
  options: { logStream?: { write(line: string): void }; databaseMaxConnections?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // (M9) trace_id/span_id on every line when a span is active; never headers.
      mixin: () => logTraceFields(),
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-hris-signature']",
          "req.headers['x-aoo-signature']",
        ],
        censor: "[REDACTED]",
      },
      ...(options.logStream && { stream: options.logStream }),
    },
    // (M9) Request ids: a safe caller-supplied X-Request-Id is reused, otherwise a UUID.
    requestIdHeader: false,
    requestIdLogLabel: "requestId",
    genReqId: (req) => normalizeRequestId(req.headers["x-request-id"]),
  });
  registerRequestObservability(app);

  // Loaded before anything else: invalid or modified catalog data fails startup.
  const catalogs = loadCatalogRegistry();
  const catalog = overrides.catalog ?? catalogs.current;

  const database = createDatabase(config.DATABASE_URL, {
    ...(options.databaseMaxConnections && { maxConnections: options.databaseMaxConnections }),
    onIdleClientError: (err) => app.log.warn({ err: err.message }, "database idle connection lost"),
  });
  app.addHook("onClose", () => database.close());
  const deps: AppDependencies = {
    hrisIntake: createHrisIntakeService(database.db),
    approvals: createApprovalService(database.db, {
      workflows: createWorkflowService(database.db),
    }),
    catalog,
    githubIdentities: createGitHubIdentityService(database.db, { catalogs }),
    manualProvisioning: createManualProvisioningService(database.db, { catalogs }),
    fulfillmentCallbacks: createServiceNowFulfillmentCallbackService(database.db),
    workflowReads: createWorkflowReadService(database.db, { catalogs }),
    operatorSessions: createOperatorSessionService(database.db),
    ...overrides,
  };

  await app.register(healthRoutes);
  await app.register(resourceRoutes, { catalog: deps.catalog });
  await app.register(hrisWebhookRoutes, {
    secret: config.HRIS_WEBHOOK_SECRET,
    bodyLimit: config.HRIS_WEBHOOK_BODY_LIMIT_BYTES,
    maxSkewMs: config.HRIS_WEBHOOK_MAX_SKEW_MS,
    intake: deps.hrisIntake,
  });

  const callbacks = callbackConfig(config);
  if (callbacks) {
    await app.register(serviceNowApprovalWebhookRoutes, {
      ...callbacks,
      bodyLimit: 16_384,
      approvals: deps.approvals,
    });
    await app.register(serviceNowFulfillmentWebhookRoutes, {
      ...callbacks,
      bodyLimit: 16_384,
      fulfillment: deps.fulfillmentCallbacks,
    });
  }

  if (config.ONBOARDING_ADMIN_TOKEN) {
    const sessions = deps.operatorSessions;
    await app.register(adminGitHubIdentityRoutes, {
      adminToken: config.ONBOARDING_ADMIN_TOKEN,
      identities: deps.githubIdentities,
      sessions,
    });
    await app.register(adminManualProvisioningRoutes, {
      adminToken: config.ONBOARDING_ADMIN_TOKEN,
      manual: deps.manualProvisioning,
      sessions,
    });
    await app.register(adminOnboardingReadRoutes, {
      adminToken: config.ONBOARDING_ADMIN_TOKEN,
      reads: deps.workflowReads,
      sessions,
    });
    await app.register(adminOperatorSessionRoutes, {
      adminToken: config.ONBOARDING_ADMIN_TOKEN,
      sessions,
    });
  }

  return app;
}
