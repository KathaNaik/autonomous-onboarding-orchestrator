import { loadCatalogRegistry, type ResourceCatalog } from "@aoo/catalog";
import { createDatabase } from "@aoo/db";
import {
  createApprovalService,
  createGitHubIdentityService,
  createHrisIntakeService,
  createWorkflowService,
  type ApprovalService,
  type GitHubIdentityService,
  type HrisIntakeService,
} from "@aoo/orchestrator";
import Fastify, { type FastifyInstance } from "fastify";
import { callbackConfig, type Config } from "./config.js";
import { adminGitHubIdentityRoutes } from "./routes/admin-github-identity.js";
import { healthRoutes } from "./routes/health.js";
import { hrisWebhookRoutes } from "./routes/hris-webhook.js";
import { resourceRoutes } from "./routes/resources.js";
import { serviceNowApprovalWebhookRoutes } from "./routes/servicenow-approval-webhook.js";

export interface AppDependencies {
  hrisIntake: HrisIntakeService;
  /** Records approval callbacks only; the API never reads ServiceNow or decides approvals. */
  approvals: ApprovalService;
  /** Current resource catalog version (read-only). */
  catalog: ResourceCatalog;
  /** (M7B) HR-recorded GitHub identity claims: records claims only, never provisions. */
  githubIdentities: GitHubIdentityService;
}

/**
 * Builds the app without listening. Dependencies default to real, database-backed services;
 * unit tests may override them. The pg pool connects lazily, so building never touches the DB.
 */
export async function buildApp(
  config: Config,
  overrides: Partial<AppDependencies> = {},
  options: { logStream?: { write(line: string): void } } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, ...(options.logStream && { stream: options.logStream }) },
  });

  // Loaded before anything else: invalid or modified catalog data fails startup.
  const catalogs = loadCatalogRegistry();
  const catalog = overrides.catalog ?? catalogs.current;

  const database = createDatabase(config.DATABASE_URL, {
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
    ...overrides,
  };

  await app.register(healthRoutes);
  await app.register(resourceRoutes, { catalog: deps.catalog });
  await app.register(hrisWebhookRoutes, {
    secret: config.HRIS_WEBHOOK_SECRET,
    bodyLimit: config.HRIS_WEBHOOK_BODY_LIMIT_BYTES,
    intake: deps.hrisIntake,
  });

  const callbacks = callbackConfig(config);
  if (callbacks) {
    await app.register(serviceNowApprovalWebhookRoutes, {
      ...callbacks,
      bodyLimit: 16_384,
      approvals: deps.approvals,
    });
  }

  if (config.ONBOARDING_ADMIN_TOKEN) {
    await app.register(adminGitHubIdentityRoutes, {
      adminToken: config.ONBOARDING_ADMIN_TOKEN,
      identities: deps.githubIdentities,
    });
  }

  return app;
}
