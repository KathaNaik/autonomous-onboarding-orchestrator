import type { RunSummary } from "@aoo/orchestrator";
import type pino from "pino";
import { runSweeps, type WorkerServices } from "./services.js";

export interface WorkerBatchOptions {
  /** Stop claiming once this many events were claimed in this invocation. */
  maxEvents: number;
  /** Stop claiming new work once this much time has elapsed (in-flight handlers finish). */
  deadlineMs: number;
  now?: () => number;
}

export type WorkerBatchStop = "IDLE" | "DEADLINE" | "MAX_EVENTS" | "ERROR";

export interface WorkerBatchResult extends RunSummary {
  batches: number;
  sweep: { wakes: number; planRequests: number; accessPlanning: number; failed: boolean };
  stoppedBy: WorkerBatchStop;
  elapsedMs: number;
}

/**
 * (M10) One bounded worker execution, for the scheduled Vercel Function: run the due sweeps,
 * then claim and process outbox batches until the queue has no immediately runnable work, the
 * event budget is spent, or the deadline passes. It never loops unboundedly and never waits for
 * delayed work (retry backoff, human waits): that stays durable in PostgreSQL for the next
 * invocation. Events a handler makes immediately runnable (a chain A → B) are drained in the
 * same invocation.
 */
export async function runWorkerBatch(
  services: Pick<WorkerServices, "runner" | "coordinator" | "onboardingPlans"> &
    Partial<Pick<WorkerServices, "accessPlanning">>,
  logger: Pick<pino.Logger, "info" | "warn" | "error">,
  options: WorkerBatchOptions,
): Promise<WorkerBatchResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const elapsed = () => now() - started;
  const result: WorkerBatchResult = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
    batches: 0,
    sweep: await runSweeps(services, logger),
    stoppedBy: "IDLE",
    elapsedMs: 0,
  };

  let stop: WorkerBatchStop | undefined;
  while (stop === undefined) {
    if (elapsed() >= options.deadlineMs) {
      stop = "DEADLINE";
      break;
    }
    const remaining = options.maxEvents - result.claimed;
    if (remaining <= 0) {
      stop = "MAX_EVENTS";
      break;
    }
    try {
      const summary = await services.runner.runOnce({ batchSize: remaining });
      result.batches += 1;
      for (const key of ["claimed", "succeeded", "retried", "deadLettered", "leaseLost"] as const) {
        result[key] += summary[key];
      }
      if (summary.claimed === 0) stop = "IDLE";
    } catch (err) {
      // Infrastructure failure (e.g. the database): stop; claimed leases expire and recover.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "worker batch: outbox poll failed",
      );
      stop = "ERROR";
    }
  }
  result.stoppedBy = stop;
  result.elapsedMs = elapsed();
  return result;
}
