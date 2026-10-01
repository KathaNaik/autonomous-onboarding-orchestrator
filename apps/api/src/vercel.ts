import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { loadTelemetryEnv, startTelemetry } from "@aoo/telemetry/sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * (M10) Vercel Node.js Function entry: the same buildApp() as the long-running server, without
 * listen(). One app instance per function instance (Fluid compute reuses it); the pg pool is
 * lazy and small. Requests are handed to Fastify's own HTTP handler, so raw-body webhook
 * signatures see the exact bytes.
 */
let ready: Promise<FastifyInstance> | undefined;

function app(): Promise<FastifyInstance> {
  ready ??= (async () => {
    const config = loadConfig();
    const otel = loadTelemetryEnv();
    startTelemetry({
      enabled: otel.OTEL_ENABLED,
      serviceName: otel.OTEL_SERVICE_NAME ?? "aoo-api",
      endpoint: otel.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
    const instance = await buildApp(config, {}, { databaseMaxConnections: 5 });
    await instance.ready();
    return instance;
  })().catch((err: unknown) => {
    ready = undefined; // a later request retries the (fixed) configuration
    throw err;
  });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let instance: FastifyInstance;
  try {
    instance = await app();
  } catch (err) {
    // Configuration errors name variables only; the response carries no detail.
    console.error(err instanceof Error ? err.message : "api misconfigured");
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "API_MISCONFIGURED" }));
    return;
  }
  instance.server.emit("request", req, res);
}
