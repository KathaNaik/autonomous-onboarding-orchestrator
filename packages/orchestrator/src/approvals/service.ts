import { createHash } from "node:crypto";
import {
  approvalCallbackEvents,
  accessRequests,
  approvals,
  auditEvents,
  externalOperations,
  outboxEvents,
  type Approval,
  type ApprovalCallbackEvent,
  type Database,
} from "@aoo/db";
import type { ApprovalState } from "@aoo/servicenow";
import {
  OUTBOX_EVENT_TYPES,
  ServiceNowApprovalCallbackSchema,
  type ApprovalStatus,
  type ServiceNowApprovalCallback,
} from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { InvalidTransitionError, WorkflowVersionConflictError } from "../errors.js";
import { noopLogger, type EventLogger } from "../events/types.js";
import { formatSanitizedError, sanitizeExternalError } from "../external-operations/sanitize.js";
import type { ServiceNowAccessRequestGateway } from "../external-operations/service.js";
import { enqueueProvisioningWake } from "../provisioning/wake.js";
import type { WorkflowService } from "../workflow-service.js";

export const APPROVAL_VERIFIER_ACTOR = "approval-verifier";

/** Maps the provider's authoritative value to our lifecycle. Anything unexpected stays PENDING. */
export function toApprovalStatus(providerState: ApprovalState | null | undefined): ApprovalStatus {
  if (providerState === "approved") return "APPROVED";
  if (providerState === "rejected") return "REJECTED";
  return "PENDING";
}

export type CallbackOutcome =
  | "APPLIED_APPROVED"
  | "APPLIED_REJECTED"
  | "ALREADY_APPLIED"
  | "STILL_PENDING"
  | "DECISION_CONFLICT"
  | "APPROVAL_NOT_REQUIRED"
  | "UNKNOWN_TICKET"
  | "IDENTITY_MISMATCH"
  | "NOT_FOUND_AT_PROVIDER";

export class ApprovalProcessingError extends Error {
  constructor(
    readonly code: "EVENT_ID_CONFLICT" | "NOT_FOUND" | "PROVIDER_NOT_CONFIGURED" | "RETRY_LATER",
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalProcessingError";
  }
}

export interface ProcessResult {
  callbackEventId: string;
  outcome: CallbackOutcome;
  alreadyProcessed: boolean;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  workflowResumed: boolean;
}

export interface ApprovalService {
  /**
   * API side: durably records an authenticated callback and enqueues its verification (one
   * transaction). Idempotent per (provider, eventId); a reused eventId with different content
   * throws EVENT_ID_CONFLICT. Makes NO decision and changes NO workflow.
   */
  recordServiceNowCallback(callback: ServiceNowApprovalCallback): Promise<{
    callbackEventId: string;
    duplicate: boolean;
  }>;
  /**
   * Worker side: verifies one recorded callback against the authoritative ServiceNow record and
   * applies the verified decision at most once, then resumes the workflow if ready. Safe to call
   * repeatedly and concurrently.
   */
  processCallback(callbackEventId: string): Promise<ProcessResult>;
  /**
   * AWAITING_APPROVAL → PROVISIONING when this approval is decided (APPROVED or REJECTED) and no
   * approval of the workflow is still PENDING.
   */
  resumeWorkflowIfReady(approvalId: string): Promise<boolean>;
  getApprovalForOperation(externalOperationId: string): Promise<Approval | null>;
}

const clock = sql`clock_timestamp()`;

export function createApprovalService(
  db: Database,
  deps: {
    servicenow?: ServiceNowAccessRequestGateway;
    workflows: WorkflowService;
    logger?: EventLogger;
  },
): ApprovalService {
  const logger = deps.logger ?? noopLogger;

  const getCallback = async (id: string) =>
    (await db.select().from(approvalCallbackEvents).where(eq(approvalCallbackEvents.id, id)))[0] ??
    null;

  /** Terminal outcome for a callback that could not be tied to a verifiable ticket. */
  async function finishWithoutApproval(
    cb: ApprovalCallbackEvent,
    status: "PROCESSED" | "REJECTED",
    outcome: CallbackOutcome,
    detail: Record<string, unknown> = {},
  ): Promise<ProcessResult> {
    const [row] = await db
      .update(approvalCallbackEvents)
      .set({ status, outcome, outcomeDetail: detail, processedAt: clock, lastError: null })
      .where(
        and(eq(approvalCallbackEvents.id, cb.id), eq(approvalCallbackEvents.status, "RECEIVED")),
      )
      .returning();
    const final = row ?? (await getCallback(cb.id))!;
    logger.warn(
      { callbackEventId: cb.id, eventId: cb.eventId, outcome: final.outcome },
      "approval callback not applied",
    );
    return {
      callbackEventId: cb.id,
      outcome: final.outcome as CallbackOutcome,
      alreadyProcessed: !row,
      approvalId: final.approvalId,
      approvalStatus: null,
      workflowResumed: false,
    };
  }

  async function resumeWorkflowIfReady(approvalId: string): Promise<boolean> {
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    // M6B: a rejection also ends the approval phase for its resource; the workflow moves on once
    // no approval is pending. The rejected resource itself stays REJECTED (never provisioned).
    if (!approval || (approval.status !== "APPROVED" && approval.status !== "REJECTED")) {
      return false;
    }
    const details = await deps.workflows.getWorkflow(approval.workflowId);
    if (!details || details.workflow.state !== "AWAITING_APPROVAL") return false;
    const [{ pending }] = (await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(eq(approvals.workflowId, approval.workflowId), eq(approvals.status, "PENDING")),
      )) as [{ pending: number }];
    if (pending > 0) return false; // other resources still await a human decision
    try {
      const wf = await deps.workflows.transition(
        {
          workflowId: approval.workflowId,
          to: "PROVISIONING",
          expectedVersion: details.workflow.version,
          actor: APPROVAL_VERIFIER_ACTOR,
          correlationId: approval.correlationKey,
          // At most one resume per approval, across retries, redeliveries and crashes.
          idempotencyKey: `approval-resume:${approval.workflowId}:${approval.id}`,
        },
        {
          // M7C: the resumed phase may now complete provisioning; wake it atomically.
          effects: (tx) =>
            enqueueProvisioningWake(tx, {
              workflowId: approval.workflowId,
              reason: "WORKFLOW_RESUMED",
              key: `resume:${approval.id}`,
            }).then(() => undefined),
        },
      );
      logger.info(
        { approvalId, workflowId: wf.id, state: wf.state },
        "workflow resumed after approval",
      );
      return wf.state === "PROVISIONING";
    } catch (err) {
      if (err instanceof WorkflowVersionConflictError) {
        throw new ApprovalProcessingError(
          "RETRY_LATER",
          true,
          "workflow changed concurrently; retrying",
        );
      }
      if (err instanceof InvalidTransitionError) return false;
      throw err;
    }
  }

  return {
    async recordServiceNowCallback(rawCallback) {
      const callback = ServiceNowApprovalCallbackSchema.parse(rawCallback);
      const payloadSha256 = createHash("sha256").update(JSON.stringify(callback)).digest("hex");
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(approvalCallbackEvents)
          .values({
            provider: "servicenow",
            eventId: callback.eventId,
            externalId: callback.sysId,
            externalReference: callback.number,
            correlationKey: callback.correlationKey,
            claimedState: callback.claimedApprovalState ?? null,
            payloadSha256,
          })
          .onConflictDoNothing({
            target: [approvalCallbackEvents.provider, approvalCallbackEvents.eventId],
          })
          .returning();
        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(approvalCallbackEvents)
            .where(
              and(
                eq(approvalCallbackEvents.provider, "servicenow"),
                eq(approvalCallbackEvents.eventId, callback.eventId),
              ),
            );
          if (existing!.payloadSha256 !== payloadSha256) {
            throw new ApprovalProcessingError(
              "EVENT_ID_CONFLICT",
              false,
              "event id reused with different content",
            );
          }
          return { callbackEventId: existing!.id, duplicate: true };
        }
        await tx.insert(outboxEvents).values({
          idempotencyKey: `${OUTBOX_EVENT_TYPES.approvalCallbackReceived}:${inserted.id}`,
          aggregateType: "approval_callback",
          aggregateId: inserted.id,
          eventType: OUTBOX_EVENT_TYPES.approvalCallbackReceived,
          payload: { callbackEventId: inserted.id },
          correlationId: callback.correlationKey,
        });
        return { callbackEventId: inserted.id, duplicate: false };
      });
    },

    async processCallback(callbackEventId) {
      const cb = await getCallback(callbackEventId);
      if (!cb) throw new ApprovalProcessingError("NOT_FOUND", false, "callback event not found");

      if (cb.status !== "RECEIVED") {
        // Already verified earlier; finishing an interrupted resume is still idempotent.
        const resumed = cb.approvalId ? await resumeWorkflowIfReady(cb.approvalId) : false;
        const approval = cb.approvalId
          ? ((await db.select().from(approvals).where(eq(approvals.id, cb.approvalId)))[0] ?? null)
          : null;
        return {
          callbackEventId,
          outcome: cb.outcome as CallbackOutcome,
          alreadyProcessed: true,
          approvalId: cb.approvalId,
          approvalStatus: approval?.status ?? null,
          workflowResumed: resumed,
        };
      }
      await db
        .update(approvalCallbackEvents)
        .set({ attempts: sql`${approvalCallbackEvents.attempts} + 1` })
        .where(eq(approvalCallbackEvents.id, cb.id));

      // 1. Local identity: the callback must point at a ticket we created.
      const [op] = await db
        .select()
        .from(externalOperations)
        .where(
          and(
            eq(externalOperations.provider, "servicenow"),
            eq(externalOperations.correlationKey, cb.correlationKey),
          ),
        );
      if (!op) return finishWithoutApproval(cb, "REJECTED", "UNKNOWN_TICKET");
      if (op.status !== "SUCCEEDED") {
        throw new ApprovalProcessingError(
          "RETRY_LATER",
          true,
          `ticket creation is ${op.status}; verifying later`,
        );
      }
      if (op.externalId !== cb.externalId || op.externalReference !== cb.externalReference) {
        return finishWithoutApproval(cb, "REJECTED", "IDENTITY_MISMATCH", {
          mismatched: [
            ...(op.externalId !== cb.externalId ? ["sysId"] : []),
            ...(op.externalReference !== cb.externalReference ? ["number"] : []),
          ],
        });
      }
      const [approval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.externalOperationId, op.id));
      if (!approval) return finishWithoutApproval(cb, "PROCESSED", "APPROVAL_NOT_REQUIRED");

      // 2. Authoritative read-back. The callback's own claims are never used.
      if (!deps.servicenow) {
        throw new ApprovalProcessingError(
          "PROVIDER_NOT_CONFIGURED",
          false,
          "servicenow is not configured on this worker",
        );
      }
      let record;
      try {
        record = await deps.servicenow.getAccessRequest(approval.externalId);
      } catch (err) {
        const safe = sanitizeExternalError(err, {
          provider: "servicenow",
          correlationKey: cb.correlationKey,
        });
        await db
          .update(approvalCallbackEvents)
          .set({ lastError: formatSanitizedError(safe) })
          .where(eq(approvalCallbackEvents.id, cb.id));
        throw new ApprovalProcessingError("RETRY_LATER", true, formatSanitizedError(safe));
      }
      if (!record) return finishWithoutApproval(cb, "REJECTED", "NOT_FOUND_AT_PROVIDER");
      const identityMismatch = [
        ...(record.sysId !== approval.externalId ? ["sysId"] : []),
        ...(record.number !== approval.externalReference ? ["number"] : []),
        ...(record.correlationKey !== approval.correlationKey ? ["correlationKey"] : []),
      ];
      if (identityMismatch.length > 0) {
        return finishWithoutApproval(cb, "REJECTED", "IDENTITY_MISMATCH", {
          mismatched: identityMismatch,
        });
      }
      const verified = toApprovalStatus(record.approvalState);
      const claimMismatch =
        cb.claimedState !== null && toApprovalStatus(cb.claimedState as ApprovalState) !== verified;

      // 3. Apply exactly once, serialized on the callback and approval rows.
      const result = await db.transaction(async (tx) => {
        const [lockedCb] = await tx
          .select()
          .from(approvalCallbackEvents)
          .where(eq(approvalCallbackEvents.id, cb.id))
          .for("update");
        const [current] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, approval.id))
          .for("update");
        if (lockedCb!.status !== "RECEIVED") {
          return {
            outcome: lockedCb!.outcome as CallbackOutcome,
            status: current!.status,
            already: true,
          };
        }
        let outcome: CallbackOutcome;
        if (verified === "PENDING") {
          outcome = "STILL_PENDING";
          await tx
            .update(approvals)
            .set({ providerState: record.approvalState, verifiedAt: clock, updatedAt: clock })
            .where(eq(approvals.id, current!.id));
        } else if (current!.status === "PENDING") {
          outcome = verified === "APPROVED" ? "APPLIED_APPROVED" : "APPLIED_REJECTED";
          await tx
            .update(approvals)
            .set({
              status: verified,
              providerState: record.approvalState,
              verifiedAt: clock,
              decidedAt: clock,
              decidedByEventId: cb.eventId,
              version: sql`${approvals.version} + 1`,
              updatedAt: clock,
            })
            .where(eq(approvals.id, current!.id));
          // M6B: the verified decision settles the per-resource lifecycle in the same transaction.
          const settled = await tx
            .update(accessRequests)
            .set({
              status: verified === "APPROVED" ? "READY_FOR_PROVISIONING" : "REJECTED",
              authorizedVia: verified === "APPROVED" ? "APPROVAL" : null,
              approvalId: current!.id,
              version: sql`${accessRequests.version} + 1`,
              updatedAt: clock,
            })
            .where(
              and(
                eq(accessRequests.externalOperationId, current!.externalOperationId),
                eq(accessRequests.status, "AWAITING_APPROVAL"),
              ),
            )
            .returning();
          for (const request of settled) {
            await tx
              .insert(auditEvents)
              .values({
                workflowId: request.workflowId,
                eventType:
                  verified === "APPROVED" ? "access.approval_verified" : "access.approval_rejected",
                actor: APPROVAL_VERIFIER_ACTOR,
                correlationId: current!.correlationKey,
                idempotencyKey: `access-request:${request.id}:${verified}`,
                payload: {
                  accessRequestId: request.id,
                  accessDecisionId: request.accessDecisionId,
                  agentRunId: request.agentRunId,
                  resourceId: request.resourceId,
                  status: request.status,
                  approvalId: current!.id,
                  externalOperationId: current!.externalOperationId,
                  externalReference: current!.externalReference,
                },
              })
              .onConflictDoNothing();
          }
          if (settled.length > 0) {
            // M7C: an approved resource is now runnable (a rejected one settled): wake provisioning
            // in the same transaction, so the wake can never be lost after the commit.
            await enqueueProvisioningWake(tx, {
              workflowId: current!.workflowId,
              reason: "APPROVAL_DECIDED",
              key: `approval:${current!.id}:${verified}`,
            });
          }
          await tx.insert(auditEvents).values({
            workflowId: current!.workflowId,
            eventType: verified === "APPROVED" ? "approval.approved" : "approval.rejected",
            actor: APPROVAL_VERIFIER_ACTOR,
            correlationId: current!.correlationKey,
            payload: {
              approvalId: current!.id,
              externalReference: current!.externalReference,
              callbackEventId: cb.id,
              eventId: cb.eventId,
            },
          });
        } else if (current!.status === verified) {
          outcome = "ALREADY_APPLIED";
        } else {
          // A decision was already applied and the authoritative state now disagrees: surface it,
          // never flip a decision automatically (downstream effects may already have happened).
          outcome = "DECISION_CONFLICT";
          await tx.insert(auditEvents).values({
            workflowId: current!.workflowId,
            eventType: "approval.conflict",
            actor: APPROVAL_VERIFIER_ACTOR,
            correlationId: current!.correlationKey,
            payload: {
              approvalId: current!.id,
              applied: current!.status,
              providerNow: verified,
              eventId: cb.eventId,
            },
          });
        }
        await tx
          .update(approvalCallbackEvents)
          .set({
            status: "PROCESSED",
            outcome,
            outcomeDetail: {
              verifiedState: verified,
              ...(claimMismatch && { claimMismatch: true }),
            },
            approvalId: current!.id,
            processedAt: clock,
            lastError: null,
          })
          .where(eq(approvalCallbackEvents.id, cb.id));
        const statusNow = outcome.startsWith("APPLIED_") ? verified : current!.status;
        return { outcome, status: statusNow, already: false };
      });

      logger.info(
        {
          callbackEventId: cb.id,
          eventId: cb.eventId,
          outcome: result.outcome,
          approvalId: approval.id,
        },
        "approval callback verified",
      );
      // 4. Once a verified decision leaves no approval pending, the approval phase is over
      //    (idempotent; retried on conflict). Per-resource records say what was authorized.
      const workflowResumed =
        result.status === "APPROVED" || result.status === "REJECTED"
          ? await resumeWorkflowIfReady(approval.id)
          : false;
      return {
        callbackEventId: cb.id,
        outcome: result.outcome,
        alreadyProcessed: result.already,
        approvalId: approval.id,
        approvalStatus: result.status,
        workflowResumed,
      };
    },

    resumeWorkflowIfReady,

    async getApprovalForOperation(externalOperationId) {
      return (
        (
          await db
            .select()
            .from(approvals)
            .where(eq(approvals.externalOperationId, externalOperationId))
        )[0] ?? null
      );
    },
  };
}
