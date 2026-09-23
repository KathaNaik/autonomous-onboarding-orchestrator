import { readFileSync } from "node:fs";
import { HealthResponseSchema, type HealthResponse } from "@aoo/shared";
import type { FastifyPluginAsync } from "fastify";

// Resolves to apps/api/package.json from both src/routes and dist/routes.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (): Promise<HealthResponse> => {
    return HealthResponseSchema.parse({
      status: "ok",
      service: "api",
      version,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });
};
