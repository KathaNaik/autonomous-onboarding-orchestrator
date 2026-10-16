import {
  accessRequests,
  approvals,
  auditEvents,
  externalOperations,
  onboardingWorkflows,
  outboxEvents,
  workflowProvisioningPlans,
  type Database,
} from "@aoo/db";
import {
  ApprovalRerequestRequestedPayloadSchema,
  OUTBOX_EVENT_TYPES,
  type OperatorActionErrorCode,
  type RequestApprovalAgainResponse,
  type RetryResourceResponse,
} from "@aoo/shared";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { formatSanitizedError, sanitizeExternalError } from "../external-operations/sanitize.js";
import { generationSuffix } from "../external-operations/keys.js";
import type {
  ExternalOperationService,
  ServiceNowAccessRequestGateway,
} from "../external-operations/service.js";
import { OPERATOR_ID_PATTERN } from "../provisioning/github-identity.js";
import { OKTA_ENSURE_USER } from "../provisioning/okta-handlers.js";
import { enqueueProvisioningWake } from "../provisioning/wake.js";
import { isTerminal } from "../state-machine.js";
import { outboxTraceColumns } from "../telemetry.js";

/**
 * M13 operator actions on one resource. Neither changes or bypasses authorization: a retry only
 * re-runs provisioning of an already authorized resource, and a re-request only replaces an
 * approval ticket that ServiceNow confirms no longer exists (the new ticket still needs a person
 * to approve it).
 */

export class OperatorActionError extends Error {
  constructor(
    readonly code: Exclude<OperatorActionErrorCode, "OPERATOR_UNAUTHORIZED" | "INTERNAL_ERROR">,
    message: string,
  ) {
    super(message);
    this.name = "OperatorActionError";
  }
}

/** Worker-side failure that the outbox should retry (e.g. ServiceNow unreachable). */
export class ApprovalRerequestRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRerequestRetryableError";
  }
}

export type ApprovalRerequestOutcome =
  /** The old ticket is gone: a new ticket was requested and the old approval superseded. */
  | "REPLACED"
  /** ServiceNow still has the ticket: nothing changed (the approver should act on it). */
  | "TICKET_STILL_EXISTS"
  /** The approval was decided or replaced meanwhile: nothing to do. */
  | "NOT_PENDING";

export interface ApprovalRerequestResult {
  outcome: ApprovalRerequestOutcome;
  approvalId: string;
  newOperationId?: string;
}

export interface OperatorActionService {
  /** PROVISIONING_FAILED → READY_FOR_PROVISIONING with a new retry generation, audit and wake. */
  retryFailedResource(input: {
    accessRequestId: string;
    operatorId: string;
  }): Promise<RetryResourceResponse>;
  /** Records the operator's request; a worker checks ServiceNow and replaces a missing ticket. */
  requestApprovalAgain(input: {
    accessRequestId: string;
    operatorId: string;
  }): Promise<RequestApprovalAgainResponse>;
  /** Worker: handles one approval.rerequest.requested event (idempotent). */
  processApprovalRerequest(input: {
    accessRequestId: string;
    approvalId: string;
    operatorId: string;
  }): Promise<ApprovalRerequestResult>;
}

const clock = sql`clock_timestamp()`;

export function createOperatorActionService(
  db: Database,
  deps: {
    /** Worker only: creates the replacement approval ticket. */
    externalOperations?: Pick<ExternalOperationService, "requestServiceNowAccessRequest">;
    /** Worker only: reads the current ticket back. */
    servicenow?: Pick<ServiceNowAccessRequestGateway, "getAccessRequest">;
  } = {},
): OperatorActionService {
  function checkOperator(operatorId: string) {
    if (!OPERATOR_ID_PATTERN.test(operatorId)) {
      throw new OperatorActionError("OPERATOR_ID_REQUIRED", "operator id is required");
    }
  }

  /** The request, its workflow and its plan; refuses terminal workflows and historical runs. */
  async function loadInActivePlan(accessRequestId: string) {
    const [found] = await db
      .select({ request: accessRequests, workflow: onboardingWorkflows })
      .from(accessRequests)
      .innerJoin(onboardingWorkflows, eq(onboardingWorkflows.id, accessRequests.workflowId))
      .where(eq(accessRequests.id, accessRequestId));
    if (!found) {
      throw new OperatorActionError("ACCESS_REQUEST_NOT_FOUND", "access request not found");
    }
    if (isTerminal(found.workflow.state)) {
      throw new OperatorActionError(
        "WORKFLOW_NOT_ACTIVE",
        `the workflow is ${found.workflow.state}`,
      );
    }
    const [plan] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(
        and(
          eq(workflowProvisioningPlans.workflowId, found.request.workflowId),
          eq(workflowProvisioningPlans.agentRunId, found.request.agentRunId),
          eq(workflowProvisioningPlans.status, "ACTIVE"),
        ),
      );
    if (!plan) {
      throw new OperatorActionError(
        "NOT_IN_ACTIVE_PLAN",
        "the resource isn't part of the workflow's active provisioning plan",
      );
    }
    return { request: found.request, plan };
  }

  return {
    async retryFailedResource({ accessRequestId, operatorId }) {
      checkOperator(operatorId);
      const { request: loaded, plan } = await loadInActivePlan(accessRequestId);
      if (loaded.status !== "PROVISIONING_FAILED") {
        throw new OperatorActionError("NOT_FAILED", `the resource is ${loaded.status}`);
      }
      return db.transaction(async (tx) => {
        const [reset] = await tx
          .update(accessRequests)
          .set({
            status: "READY_FOR_PROVISIONING",
            provisioningErrorCode: null,
            provisioningOperationId: null,
            providerSubjectId: null,
            providerTargetId: null,
            providerState: null,
            providerEvidence: null,
            provisionedAt: null,
            orchestrationBlocker: null,
            blockerClass: null,
            nextReconcileAt: null,
            retryGeneration: sql`${accessRequests.retryGeneration} + 1`,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: clock,
          })
          .where(
            and(eq(accessRequests.id, loaded.id), eq(accessRequests.status, "PROVISIONING_FAILED")),
          )
          .returning();
        if (!reset) {
          throw new OperatorActionError("NOT_FAILED", "the resource is no longer failed");
        }
        // The employee's shared Okta identity operation may have failed with the resource (e.g.
        // a rejected token); reopen it so the retry can resolve the identity again.
        const reopened = await tx
          .update(externalOperations)
          .set({ status: "PENDING", completedAt: null, updatedAt: clock })
          .where(
            and(
              eq(externalOperations.operationType, OKTA_ENSURE_USER),
              eq(
                externalOperations.idempotencyKey,
                `${OKTA_ENSURE_USER}:employee=${reset.employeeId}`,
              ),
              eq(externalOperations.status, "FAILED"),
            ),
          )
          .returning({ id: externalOperations.id });
        await tx.insert(auditEvents).values({
          workflowId: reset.workflowId,
          eventType: "resource.retry_requested",
          actor: `hr:${operatorId}`,
          correlationId: `provisioning:${reset.workflowId}`,
          idempotencyKey: `access-request:${reset.id}:retry${generationSuffix(reset.retryGeneration)}`,
          payload: {
            accessRequestId: reset.id,
            accessDecisionId: reset.accessDecisionId,
            resourceId: reset.resourceId,
            planId: plan.id,
            retryGeneration: reset.retryGeneration,
            previousErrorCode: loaded.provisioningErrorCode,
            ...(reopened.length > 0 && { reopenedOperationId: reopened[0]!.id }),
          },
        });
        await enqueueProvisioningWake(tx, {
          workflowId: reset.workflowId,
          reason: "RESOURCE_RETRY_REQUESTED",
          key: `retry:${reset.id}:${reset.retryGeneration}`,
        });
        return {
          accessRequestId: reset.id,
          workflowId: reset.workflowId,
          resourceId: reset.resourceId,
          status: "READY_FOR_PROVISIONING" as const,
          retryGeneration: reset.retryGeneration,
        };
      });
    },

    async requestApprovalAgain({ accessRequestId, operatorId }) {
      checkOperator(operatorId);
      const { request } = await loadInActivePlan(accessRequestId);
      if (request.status !== "AWAITING_APPROVAL" || !request.externalOperationId) {
        throw new OperatorActionError(
          "NOT_AWAITING_APPROVAL",
          `the resource is ${request.status}, not waiting on an approval`,
        );
      }
      const [approval] = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.externalOperationId, request.externalOperationId),
            eq(approvals.status, "PENDING"),
          ),
        );
      if (!approval) {
        // The ticket is still being created (no approval row yet) or was decided meanwhile.
        throw new OperatorActionError(
          "NOT_AWAITING_APPROVAL",
          "there is no pending approval ticket for this resource yet",
        );
      }
      const payload = ApprovalRerequestRequestedPayloadSchema.parse({
        accessRequestId: request.id,
        approvalId: approval.id,
        operatorId,
      });
      await db.transaction(async (tx) => {
        // Each request is its own event: the worker's checks make repeats harmless, and a refused
        // request (ticket still there) can be asked again later.
        await tx.insert(outboxEvents).values({
          ...outboxTraceColumns(),
          idempotencyKey: `${OUTBOX_EVENT_TYPES.approvalRerequestRequested}:${approval.id}:${randomUUID()}`,
          aggregateType: "onboarding_workflow",
          aggregateId: request.workflowId,
          eventType: OUTBOX_EVENT_TYPES.approvalRerequestRequested,
          payload,
          correlationId: approval.correlationKey,
        });
        await tx.insert(auditEvents).values({
          workflowId: request.workflowId,
          eventType: "access.approval_rerequest_requested",
          actor: `hr:${operatorId}`,
          correlationId: approval.correlationKey,
          payload: {
            accessRequestId: request.id,
            resourceId: request.resourceId,
            approvalId: approval.id,
            externalReference: approval.externalReference,
          },
        });
      });
      return {
        accessRequestId: request.id,
        approvalId: approval.id,
        status: "REQUESTED" as const,
        changed: true,
      };
    },

    async processApprovalRerequest({ accessRequestId, approvalId, operatorId }) {
      const { externalOperations: extOps, servicenow } = deps;
      if (!extOps || !servicenow) {
        throw new ApprovalRerequestRetryableError("servicenow is not configured on this worker");
      }
      const [found] = await db
        .select({ approval: approvals, request: accessRequests, operation: externalOperations })
        .from(approvals)
        .innerJoin(externalOperations, eq(externalOperations.id, approvals.externalOperationId))
        .innerJoin(accessRequests, eq(accessRequests.id, accessRequestId))
        .where(eq(approvals.id, approvalId));
      if (
        !found ||
        found.approval.status !== "PENDING" ||
        found.request.status !== "AWAITING_APPROVAL" ||
        found.request.externalOperationId !== found.approval.externalOperationId
      ) {
        return { outcome: "NOT_PENDING", approvalId };
      }
      const { approval, request, operation } = found;

      // 1. Authoritative read-back: only a ticket ServiceNow no longer has is replaced.
      let record;
      try {
        record = await servicenow.getAccessRequest(approval.externalId);
      } catch (err) {
        const safe = sanitizeExternalError(err, {
          provider: "servicenow",
          correlationKey: approval.correlationKey,
        });
        throw new ApprovalRerequestRetryableError(formatSanitizedError(safe));
      }
      if (record) {
        await db.insert(auditEvents).values({
          workflowId: request.workflowId,
          eventType: "access.approval_rerequest_refused",
          actor: "approval-rerequest",
          correlationId: approval.correlationKey,
          payload: {
            accessRequestId: request.id,
            resourceId: request.resourceId,
            approvalId: approval.id,
            externalReference: approval.externalReference,
            reason: "TICKET_STILL_EXISTS",
          },
        });
        return { outcome: "TICKET_STILL_EXISTS", approvalId };
      }

      // 2. The replacement ticket (durable and idempotent: same generation → same keys).
      const generation = request.retryGeneration + 1;
      const old = operation.request as Record<string, unknown>;
      const { operation: next } = await extOps.requestServiceNowAccessRequest({
        workflowId: request.workflowId,
        employeeId: String(old.employeeId),
        resourceId: request.resourceId,
        requestedEntitlement: String(old.requestedEntitlement),
        agentReason: String(old.agentReason ?? ""),
        policyDecision: "requires_approval",
        ...(typeof old.shortDescription === "string" && {
          shortDescription: old.shortDescription,
        }),
        actor: `hr:${operatorId}`,
        accessDecisionId: request.accessDecisionId,
        generation,
      });

      // 3. Point the resource at the new ticket and retire the old approval, together. The approval
      // row is locked first, in the same order as callback processing.
      const replaced = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, approval.id))
          .for("update");
        if (locked?.status !== "PENDING") return false;
        const [moved] = await tx
          .update(accessRequests)
          .set({
            externalOperationId: next.id,
            retryGeneration: generation,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: clock,
          })
          .where(
            and(
              eq(accessRequests.id, request.id),
              eq(accessRequests.status, "AWAITING_APPROVAL"),
              eq(accessRequests.externalOperationId, approval.externalOperationId),
            ),
          )
          .returning({ id: accessRequests.id });
        if (!moved) return false;
        await tx
          .update(approvals)
          .set({
            status: "SUPERSEDED",
            supersededAt: clock,
            version: sql`${approvals.version} + 1`,
            updatedAt: clock,
          })
          .where(eq(approvals.id, approval.id));
        await tx.insert(auditEvents).values({
          workflowId: request.workflowId,
          eventType: "access.approval_rerequested",
          actor: `hr:${operatorId}`,
          correlationId: approval.correlationKey,
          idempotencyKey: `approval:${approval.id}:superseded`,
          payload: {
            accessRequestId: request.id,
            resourceId: request.resourceId,
            approvalId: approval.id,
            previousExternalReference: approval.externalReference,
            externalOperationId: next.id,
            retryGeneration: generation,
          },
        });
        return true;
      });
      return replaced
        ? { outcome: "REPLACED", approvalId, newOperationId: next.id }
        : { outcome: "NOT_PENDING", approvalId };
    },
  };
}
