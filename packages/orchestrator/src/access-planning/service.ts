import {
  auditEvents,
  onboardingWorkflows,
  outboxEvents,
  type Database,
  type Transaction,
} from "@aoo/db";
import {
  AccessPlanningRequestedPayloadSchema,
  OUTBOX_EVENT_TYPES,
  type AccessPlanningRequestedPayload,
} from "@aoo/shared";
import { withSpan } from "@aoo/telemetry";
import { and, inArray, sql } from "drizzle-orm";
import {
  RoleAccessRunError,
  type RoleAccessRecommendationService,
} from "../agents/role-access-service.js";
import { AuthorizationError, type AccessAuthorizationService } from "../authorization/service.js";
import { noopLogger, type EventLogger } from "../events/types.js";
import { outboxTraceColumns } from "../telemetry.js";
import type { WorkflowService } from "../workflow-service.js";

export const ACCESS_PLANNING_ACTOR = "access-planning";
const BLOCKED_EVENT = "access_planning.blocked";

/**
 * M10: writes an `access.planning.requested` outbox event. Call it inside the transaction that
 * starts the workflow (RECEIVED → ACCESS_PLANNING), so the request can never be lost after a
 * commit. `key` makes the event idempotent; planning itself is idempotent anyway.
 */
export async function enqueueAccessPlanning(
  tx: Transaction | Database,
  input: AccessPlanningRequestedPayload & { key: string },
): Promise<boolean> {
  const payload = AccessPlanningRequestedPayloadSchema.parse({
    workflowId: input.workflowId,
    reason: input.reason,
  });
  const inserted = await tx
    .insert(outboxEvents)
    .values({
      ...outboxTraceColumns(),
      idempotencyKey: `${OUTBOX_EVENT_TYPES.accessPlanningRequested}:${input.key}`,
      aggregateType: "onboarding_workflow",
      aggregateId: input.workflowId,
      eventType: OUTBOX_EVENT_TYPES.accessPlanningRequested,
      payload,
      correlationId: `access-planning:${input.workflowId}`,
    })
    .onConflictDoNothing()
    .returning({ id: outboxEvents.id });
  return inserted.length > 0;
}

export type AccessPlanningOutcome = "AUTHORIZED" | "NOT_APPLICABLE";

export interface AccessPlanningResult {
  readonly outcome: AccessPlanningOutcome;
  readonly workflowState: string;
  readonly agentRunId: string | null;
  /** True when the agent run already existed (no model call this time). */
  readonly recommendationReplayed: boolean;
  readonly summary: {
    readonly total: number;
    readonly allowed: number;
    readonly denied: number;
    readonly requiresApproval: number;
  } | null;
}

export class AccessPlanningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AccessPlanningError";
  }
}

export interface AccessPlanningService {
  /**
   * Runs the Role Access Agent for the workflow (recommends only), then authorizes the completed
   * run with the policy engine (one decision per resource, approvals routed to ServiceNow). Both
   * steps are the existing idempotent services: re-invocation replays, never duplicates.
   */
  planAccess(input: { workflowId: string }): Promise<AccessPlanningResult>;
  /** Recovery: one de-duplicated request per sweep bucket for workflows still to plan. */
  enqueueDuePlanning(input?: { limit?: number }): Promise<{ enqueued: number }>;
}

/**
 * M10 automatic access planning (ACCESS_PLANNING → POLICY_REVIEW → AWAITING_APPROVAL /
 * PROVISIONING). "Agents recommend. Policies authorize." stays intact: the agent result is only
 * a recommendation set; the policy engine alone decides, through the M6B authorization service.
 */
export function createAccessPlanningService(
  db: Database,
  deps: {
    recommendations: Pick<RoleAccessRecommendationService, "recommendAccess">;
    authorization: Pick<AccessAuthorizationService, "authorizeAgentRun">;
    workflows: WorkflowService;
    sweepIntervalMs: number;
    logger?: EventLogger;
  },
): AccessPlanningService {
  const logger = deps.logger ?? noopLogger;

  /** Deterministic failures are recorded once, so the sweep stops re-requesting them. */
  async function block(workflowId: string, code: string, step: string) {
    await db
      .insert(auditEvents)
      .values({
        workflowId,
        eventType: BLOCKED_EVENT,
        actor: ACCESS_PLANNING_ACTOR,
        correlationId: `access-planning:${workflowId}`,
        payload: { step, code },
        idempotencyKey: `${BLOCKED_EVENT}:${workflowId}:${step}:${code}`,
      })
      .onConflictDoNothing();
  }

  async function planAccess({ workflowId }: { workflowId: string }) {
    return withSpan("access_planning.plan", { workflowId }, async () => {
      const details = await deps.workflows.getWorkflow(workflowId);
      if (!details)
        throw new AccessPlanningError("WORKFLOW_NOT_FOUND", "workflow not found", false);
      const state = details.workflow.state;
      if (state !== "ACCESS_PLANNING" && state !== "POLICY_REVIEW") {
        return {
          outcome: "NOT_APPLICABLE" as const,
          workflowState: state,
          agentRunId: null,
          recommendationReplayed: false,
          summary: null,
        };
      }

      let agentRunId: string;
      let replayed: boolean;
      try {
        const run = await deps.recommendations.recommendAccess({ workflowId });
        agentRunId = run.agentRunId;
        replayed = run.replayed;
      } catch (err) {
        if (err instanceof RoleAccessRunError) {
          if (!err.retryable) await block(workflowId, err.code, "recommend");
          throw new AccessPlanningError(err.code, `role access run: ${err.code}`, err.retryable);
        }
        throw err;
      }

      try {
        const auth = await deps.authorization.authorizeAgentRun({ agentRunId });
        if (!auth.complete) {
          throw new AccessPlanningError(
            "AUTHORIZATION_INCOMPLETE",
            `${auth.failures.length} resource(s) not yet decided`,
            true,
          );
        }
        logger.info(
          { workflowId, agentRunId, workflowState: auth.workflowState, ...auth.summary },
          "access planned",
        );
        return {
          outcome: "AUTHORIZED" as const,
          workflowState: auth.workflowState,
          agentRunId,
          recommendationReplayed: replayed,
          summary: {
            total: auth.summary.total,
            allowed: auth.summary.allowed,
            denied: auth.summary.denied,
            requiresApproval: auth.summary.requiresApproval,
          },
        };
      } catch (err) {
        if (err instanceof AuthorizationError) {
          if (!err.retryable) await block(workflowId, err.code, "authorize");
          throw new AccessPlanningError(err.code, `authorization: ${err.code}`, err.retryable);
        }
        throw err;
      }
    });
  }

  async function enqueueDuePlanning({ limit = 100 }: { limit?: number } = {}) {
    const bucket = Math.floor(Date.now() / deps.sweepIntervalMs);
    const due = await db
      .select({ id: onboardingWorkflows.id })
      .from(onboardingWorkflows)
      .where(
        and(
          inArray(onboardingWorkflows.state, ["ACCESS_PLANNING", "POLICY_REVIEW"]),
          sql`NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.workflowId} = ${onboardingWorkflows.id} AND ${auditEvents.eventType} = ${BLOCKED_EVENT})`,
        ),
      )
      .limit(limit);
    let enqueued = 0;
    for (const w of due) {
      if (
        await enqueueAccessPlanning(db, {
          workflowId: w.id,
          reason: "SCHEDULED_RECOVERY",
          key: `sweep:${w.id}:${bucket}`,
        })
      ) {
        enqueued++;
      }
    }
    return { enqueued };
  }

  return { planAccess, enqueueDuePlanning };
}
