import type { EventLogger, OutboxRunner, RunSummary } from "@aoo/orchestrator";

export interface WorkerState {
  workerId: string;
  startedAt: Date;
  stopping: boolean;
  /** Last completed loop iteration (success or failure); liveness signal. */
  lastLoopAt: Date | null;
  lastPollAt: Date | null;
  lastPollOk: boolean;
  lastPollError: string | null;
  consecutiveFailures: number;
  totals: Omit<RunSummary, "claimed"> & { claimed: number };
}

export interface WorkerLoop {
  state: WorkerState;
  /** Resolves when the loop has exited (after stop()). */
  run(): Promise<void>;
  /** Stops claiming new work; the in-flight batch finishes (leases cover a hard kill). */
  stop(): void;
}

export interface WorkerLoopOptions {
  workerId: string;
  runner: OutboxRunner;
  batchSize: number;
  pollIntervalMs: number;
  logger: EventLogger;
  /** Upper bound for the poll delay after repeated infrastructure errors. */
  maxErrorDelayMs?: number;
}

export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  const state: WorkerState = {
    workerId: options.workerId,
    startedAt: new Date(),
    stopping: false,
    lastLoopAt: null,
    lastPollAt: null,
    lastPollOk: false,
    lastPollError: null,
    consecutiveFailures: 0,
    totals: { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, leaseLost: 0 },
  };
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  return {
    state,
    async run() {
      options.logger.info({ workerId: state.workerId }, "worker started");
      while (!state.stopping) {
        let fullBatch = false;
        try {
          const summary = await options.runner.runOnce();
          state.lastPollAt = new Date();
          state.lastPollOk = true;
          state.lastPollError = null;
          state.consecutiveFailures = 0;
          for (const key of Object.keys(state.totals) as (keyof RunSummary)[]) {
            state.totals[key] += summary[key];
          }
          if (summary.claimed > 0) options.logger.info({ ...summary }, "outbox batch finished");
          fullBatch = summary.claimed >= options.batchSize;
        } catch (err) {
          state.lastPollOk = false;
          state.lastPollError = err instanceof Error ? err.message : String(err);
          state.consecutiveFailures += 1;
          options.logger.error(
            { err: state.lastPollError, consecutiveFailures: state.consecutiveFailures },
            "outbox poll failed",
          );
        }
        state.lastLoopAt = new Date();
        if (state.stopping || fullBatch) continue; // a full batch suggests more work: poll again now
        const delay =
          state.consecutiveFailures === 0
            ? options.pollIntervalMs
            : Math.min(
                options.maxErrorDelayMs ?? 30_000,
                options.pollIntervalMs * 2 ** Math.min(state.consecutiveFailures, 10),
              );
        await sleep(delay);
      }
      options.logger.info(
        { workerId: state.workerId, totals: state.totals },
        "worker loop stopped",
      );
    },
    stop() {
      state.stopping = true;
      wake?.();
    },
  };
}
