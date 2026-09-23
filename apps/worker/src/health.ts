import { createServer, type Server } from "node:http";
import type { WorkerState } from "./worker.js";

export interface HealthThresholds {
  /** /live fails if the loop has not completed an iteration for this long. */
  stallAfterMs: number;
}

export function healthStatus(state: WorkerState, thresholds: HealthThresholds, now = Date.now()) {
  const reference = state.lastLoopAt?.getTime() ?? state.startedAt.getTime();
  const live = now - reference < thresholds.stallAfterMs;
  const ready = live && !state.stopping && state.lastPollOk;
  return {
    live,
    ready,
    body: {
      status: ready ? "ready" : live ? "not_ready" : "stalled",
      workerId: state.workerId,
      stopping: state.stopping,
      lastPollAt: state.lastPollAt?.toISOString() ?? null,
      lastPollOk: state.lastPollOk,
      lastPollError: state.lastPollError,
      consecutiveFailures: state.consecutiveFailures,
      totals: state.totals,
      uptimeSeconds: Math.round((now - state.startedAt.getTime()) / 1000),
    },
  };
}

/**
 * GET /live  → 200 while the poll loop keeps turning (restart the process if not).
 * GET /ready → 200 when the last poll reached PostgreSQL and the worker is not shutting down.
 */
export function createHealthServer(state: WorkerState, thresholds: HealthThresholds): Server {
  return createServer((req, res) => {
    const { live, ready, body } = healthStatus(state, thresholds);
    const ok = req.url === "/live" ? live : req.url === "/ready" ? ready : undefined;
    if (req.method !== "GET" || ok === undefined) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
}
