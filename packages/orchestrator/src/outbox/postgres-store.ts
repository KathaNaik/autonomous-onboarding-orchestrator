import {
  auditEvents,
  outboxEventAttempts,
  outboxEvents,
  type Database,
  type OutboxEvent,
  type OutboxEventAttempt,
} from "@aoo/db";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { HandlerResult } from "../events/types.js";
import {
  LeaseLostError,
  rootCause,
  type ClaimedEvent,
  type FailureDisposition,
  type OutboxStore,
} from "./store.js";

const clock = sql`clock_timestamp()`;
const plusMs = (ms: number) => sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;

export interface RedriveResult {
  redriven: string[];
  /** Requested ids that were not DEAD_LETTERED (unknown, pending or processed); left untouched. */
  skipped: string[];
}

export interface PostgresOutboxStore extends OutboxStore {
  renew(claim: ClaimedEvent, leaseMs: number): Promise<Date>;
  /** Returns DEAD_LETTERED events to PENDING with a fresh retry cycle. Only touches dead letters. */
  redrive(params: { eventIds: string[]; actor: string; reason: string }): Promise<RedriveResult>;
  listDeadLetters(limit?: number): Promise<OutboxEvent[]>;
  listAttempts(eventId: string): Promise<OutboxEventAttempt[]>;
}

export function createPostgresOutboxStore(db: Database): PostgresOutboxStore {
  /** Fences a write on this exact, still-valid lease. */
  const holdsLease = (claim: ClaimedEvent) =>
    and(
      eq(outboxEvents.id, claim.id),
      eq(outboxEvents.leaseToken, claim.leaseToken),
      eq(outboxEvents.status, "PENDING"),
      gt(outboxEvents.leaseExpiresAt, clock),
    );

  return {
    async claim({ workerId, batchSize, leaseMs }) {
      return db.transaction(async (tx) => {
        // SKIP LOCKED: concurrent claimers each take different rows without waiting on each other.
        // Rows with an unexpired lease are excluded, so at most one valid claim exists per event.
        const candidates = await tx
          .select({ id: outboxEvents.id })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.status, "PENDING"),
              lte(outboxEvents.availableAt, clock),
              or(isNull(outboxEvents.leaseExpiresAt), lte(outboxEvents.leaseExpiresAt, clock)),
            ),
          )
          .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt))
          .limit(batchSize)
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);

        const claimed = await tx
          .update(outboxEvents)
          .set({
            leaseToken: sql`gen_random_uuid()`,
            leaseOwner: workerId,
            leaseExpiresAt: plusMs(leaseMs),
            attempts: sql`${outboxEvents.attempts} + 1`,
            cycleAttempts: sql`${outboxEvents.cycleAttempts} + 1`,
          })
          .where(inArray(outboxEvents.id, ids))
          .returning();

        // Any attempt still open for these events belonged to a worker whose lease expired.
        await tx
          .update(outboxEventAttempts)
          .set({
            outcome: "LEASE_EXPIRED",
            finishedAt: clock,
            error: "lease expired before completion",
          })
          .where(
            and(
              inArray(outboxEventAttempts.outboxEventId, ids),
              isNull(outboxEventAttempts.finishedAt),
            ),
          );

        await tx.insert(outboxEventAttempts).values(
          claimed.map((row) => ({
            outboxEventId: row.id,
            attemptNumber: row.attempts,
            workerId,
            leaseToken: row.leaseToken!,
            leaseExpiresAt: row.leaseExpiresAt!,
          })),
        );

        return claimed
          .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
          .map((row) => ({
            id: row.id,
            eventType: row.eventType,
            payload: row.payload,
            correlationId: row.correlationId,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            attempt: row.attempts,
            cycleAttempt: row.cycleAttempts,
            leaseToken: row.leaseToken!,
            leaseExpiresAt: row.leaseExpiresAt!,
            traceParent: row.traceParent,
            traceState: row.traceState,
          }));
      });
    },

    async complete(claim, result: HandlerResult) {
      await db.transaction(async (tx) => {
        const [done] = await tx
          .update(outboxEvents)
          .set({
            status: "PROCESSED",
            publishedAt: clock,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(holdsLease(claim))
          .returning({ id: outboxEvents.id });
        if (!done) throw new LeaseLostError(claim.id, claim.leaseToken);

        await tx
          .update(outboxEventAttempts)
          .set({
            outcome: "SUCCEEDED",
            finishedAt: clock,
            detail: { status: result.status, ...result.detail },
          })
          .where(eq(outboxEventAttempts.leaseToken, claim.leaseToken));
      });
    },

    async renew(claim, leaseMs) {
      return db.transaction(async (tx) => {
        // Fenced like complete/fail: same token, still PENDING, not yet expired. A stale or
        // reclaimed owner gets LeaseLostError and changes nothing.
        const [row] = await tx
          .update(outboxEvents)
          .set({ leaseExpiresAt: plusMs(leaseMs) })
          .where(holdsLease(claim))
          .returning({ leaseExpiresAt: outboxEvents.leaseExpiresAt });
        if (!row?.leaseExpiresAt) throw new LeaseLostError(claim.id, claim.leaseToken);
        await tx
          .update(outboxEventAttempts)
          .set({ leaseExpiresAt: row.leaseExpiresAt })
          .where(eq(outboxEventAttempts.leaseToken, claim.leaseToken));
        return row.leaseExpiresAt;
      });
    },

    async fail(claim, disposition: FailureDisposition) {
      await db.transaction(async (tx) => {
        const { error } = disposition;
        const root = rootCause(error);
        const message =
          root === error
            ? `${error.name}: ${error.message}`
            : `${error.name}: ${error.message} [root cause: ${root.name}${root.code ? ` (${root.code})` : ""}: ${root.message}]`;
        const [done] = await tx
          .update(outboxEvents)
          .set({
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: message,
            ...(disposition.deadLetter
              ? { status: "DEAD_LETTERED" as const, deadLetteredAt: clock }
              : { availableAt: plusMs(disposition.retryDelayMs) }),
          })
          .where(holdsLease(claim))
          .returning({ id: outboxEvents.id });
        if (!done) throw new LeaseLostError(claim.id, claim.leaseToken);

        await tx
          .update(outboxEventAttempts)
          .set({
            outcome: disposition.deadLetter ? "DEAD_LETTERED" : "FAILED",
            finishedAt: clock,
            error: message,
            detail: {
              error: disposition.error,
              ...(!disposition.deadLetter && { retryDelayMs: disposition.retryDelayMs }),
            },
          })
          .where(eq(outboxEventAttempts.leaseToken, claim.leaseToken));
      });
    },

    async redrive({ eventIds, actor, reason }) {
      if (eventIds.length === 0) return { redriven: [], skipped: [] };
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(outboxEvents)
          .set({
            status: "PENDING",
            deadLetteredAt: null,
            cycleAttempts: 0,
            availableAt: clock,
            redriveCount: sql`${outboxEvents.redriveCount} + 1`,
          })
          .where(and(inArray(outboxEvents.id, eventIds), eq(outboxEvents.status, "DEAD_LETTERED")))
          .returning();

        if (rows.length > 0) {
          await tx.insert(auditEvents).values(
            rows.map((row) => ({
              workflowId: row.aggregateType === "onboarding_workflow" ? row.aggregateId : null,
              eventType: "outbox.event.redriven",
              actor,
              correlationId: row.correlationId,
              payload: {
                outboxEventId: row.id,
                outboxEventType: row.eventType,
                reason,
                redriveCount: row.redriveCount,
                lastError: row.lastError,
              },
            })),
          );
        }
        const redriven = rows.map((r) => r.id);
        return { redriven, skipped: eventIds.filter((id) => !redriven.includes(id)) };
      });
    },

    listDeadLetters(limit = 100) {
      return db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.status, "DEAD_LETTERED"))
        .orderBy(desc(outboxEvents.deadLetteredAt))
        .limit(limit);
    },

    listAttempts(eventId) {
      return db
        .select()
        .from(outboxEventAttempts)
        .where(eq(outboxEventAttempts.outboxEventId, eventId))
        .orderBy(asc(outboxEventAttempts.attemptNumber));
    },
  };
}
