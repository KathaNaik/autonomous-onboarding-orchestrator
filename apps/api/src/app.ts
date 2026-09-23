import { createDatabase } from "@aoo/db";
import { createHrisIntakeService, type HrisIntakeService } from "@aoo/orchestrator";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { hrisWebhookRoutes } from "./routes/hris-webhook.js";

export interface AppDependencies {
  hrisIntake: HrisIntakeService;
}

/**
 * Builds the app without listening. Dependencies default to real, database-backed services;
 * unit tests may override them. The pg pool connects lazily, so building never touches the DB.
 */
export async function buildApp(
  config: Config,
  overrides: Partial<AppDependencies> = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  const database = createDatabase(config.DATABASE_URL);
  app.addHook("onClose", () => database.close());
  const deps: AppDependencies = {
    hrisIntake: createHrisIntakeService(database.db),
    ...overrides,
  };

  await app.register(healthRoutes);
  await app.register(hrisWebhookRoutes, {
    secret: config.HRIS_WEBHOOK_SECRET,
    bodyLimit: config.HRIS_WEBHOOK_BODY_LIMIT_BYTES,
    intake: deps.hrisIntake,
  });

  return app;
}
