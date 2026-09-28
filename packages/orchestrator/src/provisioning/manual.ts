import type { CatalogRegistry } from "@aoo/catalog";
import { accessRequests, auditEvents, workflowProvisioningPlans, type Database } from "@aoo/db";
import { and, eq, sql } from "drizzle-orm";
import { EligibilityError, loadAuthorizedRequest, resolveProviderResource } from "./eligibility.js";
import { OPERATOR_ID_PATTERN } from "./github-identity.js";
import { enqueueProvisioningWake } from "./wake.js";

export const MANUAL_EVIDENCE_MAX = 500;
export const MANUAL_EVIDENCE_MIN = 8;
/** Evidence is free text for humans; anything that looks like a credential is refused. */
const SECRET_LIKE =
  /(password|passwd|secret|token|api[_-]?key|private[_ -]?key|authorization|bearer\s|basic\s|ssws\s|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|-----BEGIN|:\/\/[^\s/]*:[^\s/]*@)/i;

export type ManualCompletionErrorCode =
  | "INVALID_OPERATOR_ID"
  | "INVALID_EVIDENCE"
  | "ACCESS_REQUEST_NOT_FOUND"
  | "NOT_ELIGIBLE"
  | "AUTHORIZATION_CHAIN_INVALID"
  | "CATALOG_UNAVAILABLE"
  | "RESOURCE_NOT_IN_CATALOG"
  /** Only provider=MANUAL resources can be completed by an operator (never OKTA/GITHUB). */
  | "PROVIDER_NOT_MANUAL"
  /** The request doesn't belong to the workflow's provisioning plan (e.g. a historical run). */
  | "NOT_IN_ACTIVE_PLAN"
  | "NOT_AWAITING_MANUAL_ACTION"
  /** Already completed with different operator/evidence: history is never rewritten. */
  | "MANUAL_ALREADY_COMPLETED";

export class ManualCompletionError extends Error {
  constructor(
    readonly code: ManualCompletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManualCompletionError";
  }
}

export interface ManualCompletionResult {
  accessRequestId: string;
  workflowId: string;
  resourceId: string;
  status: "PROVISIONED";
  /** False for an identical repeat (same operator and evidence). */
  changed: boolean;
  completedBy: string;
  provisionedAt: Date;
}

export interface ManualProvisioningService {
  /**
   * An operator confirms that an authorized provider=MANUAL resource was provisioned outside the
   * system: MANUAL_ACTION_REQUIRED → PROVISIONED with operator, timestamp, evidence, audit and a
   * provisioning wake in one transaction. Never bypasses policy authorization.
   */
  completeManualResource(input: {
    accessRequestId: string;
    operatorId: string;
    evidence: unknown;
  }): Promise<ManualCompletionResult>;
}

export function validateManualEvidence(evidence: unknown): string {
  if (typeof evidence !== "string") {
    throw new ManualCompletionError("INVALID_EVIDENCE", "evidence must be text");
  }
  const text = evidence.trim();
  if (text.length < MANUAL_EVIDENCE_MIN || text.length > MANUAL_EVIDENCE_MAX) {
    throw new ManualCompletionError(
      "INVALID_EVIDENCE",
      `evidence must be ${MANUAL_EVIDENCE_MIN}-${MANUAL_EVIDENCE_MAX} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text) || SECRET_LIKE.test(text)) {
    throw new ManualCompletionError(
      "INVALID_EVIDENCE",
      "evidence must be a short note (no credentials, secrets or control characters)",
    );
  }
  return text;
}

export function createManualProvisioningService(
  db: Database,
  options: { catalogs: CatalogRegistry },
): ManualProvisioningService {
  return {
    async completeManualResource({ accessRequestId, operatorId, evidence: rawEvidence }) {
      if (!OPERATOR_ID_PATTERN.test(operatorId)) {
        throw new ManualCompletionError("INVALID_OPERATOR_ID", "operator id is required");
      }
      const evidence = validateManualEvidence(rawEvidence);
      let authorized;
      try {
        authorized = await loadAuthorizedRequest(db, accessRequestId);
        resolveProviderResource(
          options.catalogs,
          authorized.decision,
          authorized.request,
          "MANUAL",
        );
      } catch (err) {
        if (!(err instanceof EligibilityError)) throw err;
        throw new ManualCompletionError(
          err.code === "PROVIDER_MISMATCH" ? "PROVIDER_NOT_MANUAL" : err.code,
          err.message,
        );
      }
      const { request } = authorized;
      const [plan] = await db
        .select()
        .from(workflowProvisioningPlans)
        .where(
          and(
            eq(workflowProvisioningPlans.workflowId, request.workflowId),
            eq(workflowProvisioningPlans.agentRunId, request.agentRunId),
          ),
        );
      if (!plan) {
        throw new ManualCompletionError(
          "NOT_IN_ACTIVE_PLAN",
          "the request isn't part of the workflow's provisioning plan",
        );
      }

      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(accessRequests)
          .where(eq(accessRequests.id, request.id))
          .for("update");
        if (current!.status === "PROVISIONED") {
          if (current!.manualCompletedBy === operatorId && current!.manualEvidence === evidence) {
            return {
              accessRequestId: current!.id,
              workflowId: current!.workflowId,
              resourceId: current!.resourceId,
              status: "PROVISIONED" as const,
              changed: false,
              completedBy: operatorId,
              provisionedAt: current!.provisionedAt!,
            };
          }
          throw new ManualCompletionError(
            "MANUAL_ALREADY_COMPLETED",
            "the resource was already completed; its record is not rewritten",
          );
        }
        if (current!.status !== "MANUAL_ACTION_REQUIRED" || plan.status !== "ACTIVE") {
          throw new ManualCompletionError(
            "NOT_AWAITING_MANUAL_ACTION",
            `the request is ${current!.status}, not MANUAL_ACTION_REQUIRED`,
          );
        }
        const [done] = await tx
          .update(accessRequests)
          .set({
            status: "PROVISIONED",
            provisionedAt: sql`clock_timestamp()`,
            manualCompletedBy: operatorId,
            manualEvidence: evidence,
            orchestrationBlocker: null,
            blockerClass: null,
            nextReconcileAt: null,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(accessRequests.id, current!.id),
              eq(accessRequests.status, "MANUAL_ACTION_REQUIRED"),
            ),
          )
          .returning();
        await tx.insert(auditEvents).values({
          workflowId: done!.workflowId,
          eventType: "provisioning.manual_resource_completed",
          actor: `hr:${operatorId}`,
          correlationId: `provisioning:${done!.workflowId}`,
          idempotencyKey: `provisioning:${done!.id}:manual-completed`,
          payload: {
            accessRequestId: done!.id,
            accessDecisionId: done!.accessDecisionId,
            resourceId: done!.resourceId,
            planId: plan.id,
            evidence,
          },
        });
        await enqueueProvisioningWake(tx, {
          workflowId: done!.workflowId,
          reason: "MANUAL_RESOURCE_COMPLETED",
          key: `manual:${done!.id}`,
        });
        return {
          accessRequestId: done!.id,
          workflowId: done!.workflowId,
          resourceId: done!.resourceId,
          status: "PROVISIONED" as const,
          changed: true,
          completedBy: operatorId,
          provisionedAt: done!.provisionedAt!,
        };
      });
    },
  };
}
