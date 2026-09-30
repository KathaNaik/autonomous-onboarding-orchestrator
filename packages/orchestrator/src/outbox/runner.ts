import {
  ROOT_CONTEXT,
  SpanKind,
  annotateActiveSpan,
  contextFromTraceParent,
  errorType,
  withSpan,
} from "@aoo/telemetry";
import {
  PermanentEventError,
  noopLogger,
  type EventEnvelope,
  type EventHandlerRegistry,
  type EventLogger,
} from "../events/types.js";
import { computeBackoffMs, type RetryPolicy } from "./backoff.js";
import { LeaseLostError, type ClaimedEvent, type ErrorInfo, type OutboxStore } from "./store.js";

export interface OutboxRunnerOptions {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  retry: RetryPolicy;
  handlers: EventHandlerRegistry;
  logger?: EventLogger;
  random?: () => number;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
}

export interface OutboxRunner {
  /** Claims one batch, runs handlers concurrently, and records each outcome. */
  runOnce(): Promise<RunSummary>;
}

/** Serializes an error and (up to 5 levels of) its cause chain, keeping codes. */
export function describeError(err: unknown, depth = 0): ErrorInfo {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === "string" && { code }),
      ...(err.stack !== undefined && { stack: err.stack.split("\n").slice(0, 8).join("\n") }),
      ...(err.cause !== undefined && depth < 5 && { cause: describeError(err.cause, depth + 1) }),
    };
  }
  return { name: "NonError", message: String(err) };
}

export function createOutboxRunner(store: OutboxStore, options: OutboxRunnerOptions): OutboxRunner {
  const logger = options.logger ?? noopLogger;

  /**
   * (M9) One span per delivery, parented on the trace context persisted with the event (request →
   * outbox → worker), or a new trace for historical events. Tracing never affects the outcome.
   */
  function processOne(claim: ClaimedEvent, summary: RunSummary): Promise<void> {
    return withSpan(
      `outbox.process ${claim.eventType}`,
      {
        outboxEventId: claim.id,
        outboxEventType: claim.eventType,
        deliveryAttempt: claim.cycleAttempt,
        workflowId: claim.aggregateType === "onboarding_workflow" ? claim.aggregateId : undefined,
      },
      () => processClaim(claim, summary),
      {
        parent: contextFromTraceParent(claim.traceParent, claim.traceState) ?? ROOT_CONTEXT,
        kind: SpanKind.CONSUMER,
      },
    );
  }

  async function processClaim(claim: ClaimedEvent, summary: RunSummary): Promise<void> {
    const log = {
      eventId: claim.id,
      eventType: claim.eventType,
      attempt: claim.attempt,
      cycleAttempt: claim.cycleAttempt,
      correlationId: claim.correlationId,
    };
    const envelope: EventEnvelope = {
      id: claim.id,
      type: claim.eventType,
      payload: claim.payload,
      correlationId: claim.correlationId,
      aggregateType: claim.aggregateType,
      aggregateId: claim.aggregateId,
      deliveryAttempt: claim.cycleAttempt,
    };

    try {
      try {
        const handler = options.handlers[claim.eventType];
        if (!handler) throw new PermanentEventError(`no handler for event type ${claim.eventType}`);
        const result = await handler(envelope, { logger });
        await store.complete(claim, result);
        summary.succeeded += 1;
        annotateActiveSpan({ outcome: result.status });
        logger.info(
          { ...log, result: result.status, detail: result.detail },
          "outbox event processed",
        );
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        const permanent = err instanceof PermanentEventError;
        const exhausted = claim.cycleAttempt >= options.retry.maxAttempts;
        const deadLetter = permanent || exhausted;
        const retryDelayMs = deadLetter
          ? 0
          : computeBackoffMs(claim.cycleAttempt, options.retry, options.random);
        const error = describeError(err);
        await store.fail(claim, { error, deadLetter, retryDelayMs });
        annotateActiveSpan({
          outcome: deadLetter ? "dead_lettered" : "retry_scheduled",
          errorType: errorType(err),
        });
        if (deadLetter) {
          summary.deadLettered += 1;
          logger.error(
            { ...log, err: error, reason: permanent ? "permanent" : "retries_exhausted" },
            "outbox event dead-lettered",
          );
        } else {
          summary.retried += 1;
          logger.warn({ ...log, err: error, retryDelayMs }, "outbox event failed; retry scheduled");
        }
      }
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
      // Another worker reclaimed the event (or our lease ran out); our result is discarded.
      // Handlers are idempotent, so the new owner's run converges on the same outcome.
      summary.leaseLost += 1;
      annotateActiveSpan({ outcome: "lease_lost" });
      logger.warn(log, "outbox lease lost; result discarded");
    }
  }

  return {
    async runOnce() {
      const claims = await store.claim({
        workerId: options.workerId,
        batchSize: options.batchSize,
        leaseMs: options.leaseMs,
      });
      const summary: RunSummary = {
        claimed: claims.length,
        succeeded: 0,
        retried: 0,
        deadLettered: 0,
        leaseLost: 0,
      };
      const results = await Promise.allSettled(claims.map((c) => processOne(c, summary)));
      for (const r of results) {
        // Only store/infrastructure errors land here; the lease will expire and the event is retried.
        if (r.status === "rejected") {
          logger.error({ err: describeError(r.reason) }, "outbox event outcome not recorded");
        }
      }
      return summary;
    },
  };
}
