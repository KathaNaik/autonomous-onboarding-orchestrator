import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pino from "pino";
import { runWorkerBatch, type WorkerBatchOptions } from "./batch.js";
import { loadConfig, loadWorkerFunctionConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { QSTASH_SIGNATURE_HEADER, createQStashVerifier, type QStashVerifier } from "./qstash.js";
import { createWorkerServices, type WorkerServices } from "./services.js";

/** QStash schedule bodies are tiny ({"source":"qstash-schedule"}); anything larger is refused. */
export const MAX_BODY_BYTES = 4096;

export interface WorkerFunctionRuntime {
  logger: pino.Logger;
  verifier: QStashVerifier;
  batch: WorkerBatchOptions;
  /** Built only after a delivery has been authenticated (no database work before that). */
  services(): WorkerServices;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function send(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** Reads the exact raw bytes (signature verification needs them); null when over the limit. */
async function readRawBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * (M10) POST /api/worker/run: the only production execution path of the serverless worker.
 * Order: method → bounded raw body → QStash signature (current or next key, subject, body hash,
 * exp/nbf) → bounded batch. An unauthenticated request does no database or provider work.
 * Duplicate deliveries are harmless: all work is durable, leased and idempotent in PostgreSQL.
 */
export function createWorkerFunctionHandler(runtime: () => WorkerFunctionRuntime): Handler {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    }
    let rt: WorkerFunctionRuntime;
    try {
      rt = runtime();
    } catch (err) {
      // Configuration errors name variables only (never values); keep details out of responses.
      console.error(err instanceof Error ? err.message : "worker function misconfigured");
      return send(res, 500, { error: "WORKER_MISCONFIGURED" });
    }
    const invocationId = randomUUID();
    const log = rt.logger.child({ invocationId });
    const body = await readRawBody(req, MAX_BODY_BYTES);
    if (body === null) return send(res, 413, { error: "PAYLOAD_TOO_LARGE" });
    const header = req.headers[QSTASH_SIGNATURE_HEADER];
    const signature = typeof header === "string" ? header : undefined;
    if (!(await rt.verifier.verify({ signature, body }))) {
      log.warn({ signaturePresent: signature !== undefined }, "worker run rejected: unauthorized");
      return send(res, 401, { error: "UNAUTHORIZED" });
    }
    try {
      const result = await runWorkerBatch(rt.services(), log, rt.batch);
      log.info({ ...result }, "worker run finished");
      return send(res, 200, { status: "ok", invocationId, ...result });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "worker run failed");
      return send(res, 500, { error: "WORKER_RUN_FAILED", invocationId });
    }
  };
}

/** Production runtime from environment variables, created once per function instance. */
export function environmentRuntime(env: NodeJS.ProcessEnv = process.env) {
  let cached: WorkerFunctionRuntime | undefined;
  let services: WorkerServices | undefined;
  return (): WorkerFunctionRuntime => {
    if (cached) return cached;
    const config = loadConfig(env);
    const fn = loadWorkerFunctionConfig(config, env);
    const logger = createLogger(config.LOG_LEVEL, config.WORKER_ID);
    cached = {
      logger,
      verifier: createQStashVerifier({
        currentSigningKey: fn.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: fn.QSTASH_NEXT_SIGNING_KEY,
        url: fn.WORKER_QSTASH_URL,
      }),
      batch: { maxEvents: fn.WORKER_RUN_MAX_EVENTS, deadlineMs: fn.WORKER_RUN_DEADLINE_MS },
      services: () =>
        (services ??= createWorkerServices(config, logger, {
          // Neon's pooled endpoint: a small per-instance pool is enough for one batch.
          maxConnections: config.OUTBOX_BATCH_SIZE * 2 + 2,
          env,
        })),
    };
    return cached;
  };
}

/** Vercel Node.js Function entry (apps/worker/api/worker/run.js re-exports it). */
export default createWorkerFunctionHandler(environmentRuntime());

/** Liveness only: no database, no configuration details. */
export function healthHandler(_req: IncomingMessage, res: ServerResponse): void {
  send(res, 200, { status: "ok", service: "worker" });
}
