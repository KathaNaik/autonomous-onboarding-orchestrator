import { HealthResponseSchema, type HealthResponse } from "@aoo/shared";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const body: HealthResponse = HealthResponseSchema.parse({
    status: "ok",
    service: "web",
    version: pkg.version,
    uptimeSeconds: process.uptime(),
    timestamp: new Date().toISOString(),
  });
  return Response.json(body);
}
