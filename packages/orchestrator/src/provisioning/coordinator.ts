import { randomUUID } from "node:crypto";
import {
  CatalogError,
  type CatalogRegistry,
  type CatalogResource,
  type ResourceCatalog,
} from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  auditEvents,
  onboardingWorkflows,
  workflowProvisioningPlans,
  type AccessDecision,
  type AccessRequest,
  type Database,
  type Transaction,
  type WorkflowProvisioningPlan,
} from "@aoo/db";
import type { WorkflowState } from "@aoo/shared";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { InvalidTransitionError, WorkflowVersionConflictError } from "../errors.js";
import { noopLogger, type EventLogger } from "../events/types.js";
import type { WorkflowService } from "../workflow-service.js";
import type { GitHubProvisioningService } from "./github-service.js";
import type { OktaProvisioningService } from "./okta-service.js";
import type { ServiceNowFulfillmentService } from "./servicenow-fulfillment.js";
import {
  PROVISIONING_ACTOR,
  ProvisioningPlanError,
  adoptLegacyPlan,
  type PlanIssueCode,
} from "./plan.js";
import {
  BLOCKERS,
  classifyDispatchError,
  completionState,
  dependencyState,
  dispatchKind,
  isSettled,
  statusBlocker,
  topologicalOrder,
  type Blocker,
  type RequestStatus,
} from "./scheduling.js";
import { enqueueProvisioningWake } from "./wake.js";

/** Timed external waits: not re-read before their next_reconcile_at (no busy loop). */
const SCHEDULED_WAITS = new Set<string>([
  BLOCKERS.GITHUB_INVITATION_PENDING.code,
  BLOCKERS.SERVICENOW_FULFILLMENT_PENDING.code,
  BLOCKERS.SERVICENOW_FULFILLMENT_IN_PROGRESS.code,
]);

/** Workflow phases in which authorized resources are provisioned (per-resource, not a gate). */
const COORDINATED_STATES: readonly WorkflowState[] = ["AWAITING_APPROVAL", "PROVISIONING"];

export interface ProvisioningCoordinatorOptions {
  catalogs: CatalogRegistry;
  workflows: WorkflowService;
  /** The existing M7A service (absent: OKTA resources are blocked as PROVIDER_NOT_CONFIGURED). */
  okta?: Pick<OktaProvisioningService, "provisionOktaAccess">;
  /** The existing M7B service (absent: GITHUB resources are blocked as PROVIDER_NOT_CONFIGURED). */
  github?: Pick<GitHubProvisioningService, "provisionGitHubAccess">;
  /** (M7D) The ServiceNow fulfillment service (absent: SERVICENOW resources PROVIDER_NOT_CONFIGURED). */
  servicenow?: Pick<ServiceNowFulfillmentService, "provisionServiceNowAccess">;
  /** How long to wait before re-reading an external waiting state (e.g. a GitHub invitation). */
  reconcileIntervalMs?: number;
  /** (M7D) How long to wait before re-reading a pending ServiceNow fulfillment. */
  fulfillmentReconcileIntervalMs?: number;
  /** Delay before retrying a transient provider failure (and the in-flight crash-recovery mark). */
  retryDelayMs?: number;
  /** Stop starting new dispatches after this long and continue in a fresh wake (lease safety). */
  deadlineMs?: number;
  /** Bucket for de-duplicating periodic wakes across workers and sweeps. */
  sweepIntervalMs?: number;
  maxPasses?: number;
  logger?: EventLogger;
}

export interface CoordinatedResource {
  accessRequestId: string;
  resourceId: string;
  provider: string | null;
  status: RequestStatus;
  blocker: string | null;
  blockerClass: string | null;
}

export interface ProvisioningCoordinationResult {
  workflowId: string;
  planId: string | null;
  agentRunId: string | null;
  /**
   * NOT_APPLICABLE: the workflow isn't in a provisioning phase. PLAN_BLOCKED: no trustworthy
   * plan (see planIssue). IN_PROGRESS: unresolved resources remain. COMPLETED: this call moved the
   * workflow to ONBOARDING_GENERATION. ALREADY_COMPLETE: the plan was already complete.
   */
  outcome: "NOT_APPLICABLE" | "PLAN_BLOCKED" | "IN_PROGRESS" | "COMPLETED" | "ALREADY_COMPLETE";
  planIssue: PlanIssueCode | null;
  workflowState: WorkflowState | null;
  transitioned: boolean;
  /** Resource ids in the order this call dispatched them to a provider service. */
  dispatchOrder: string[];
  resources: CoordinatedResource[];
}

export interface ProvisioningCoordinator {
  /**
   * Drives one workflow's active provisioning plan: dispatches runnable resources (dependencies
   * first) to the existing provider services, records blockers, and moves the workflow
   * PROVISIONING → ONBOARDING_GENERATION exactly once when every resource is settled. Safe under
   * at-least-once delivery and concurrent callers. Never calls a provider API itself.
   */
  coordinateProvisioning(input: { workflowId: string }): Promise<ProvisioningCoordinationResult>;
  /**
   * Periodic reconciliation: enqueues (de-duplicated) wakes for plans with a due resource and for
   * legacy workflows without a plan. Returns how many wakes were newly enqueued.
   */
  enqueueDueWakes(input?: { limit?: number }): Promise<{ enqueued: number }>;
}

type Row = { request: AccessRequest; decision: AccessDecision };

export function createProvisioningCoordinator(
  db: Database,
  options: ProvisioningCoordinatorOptions,
): ProvisioningCoordinator {
  const { catalogs, workflows } = options;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 300_000;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const fulfillmentReconcileIntervalMs = options.fulfillmentReconcileIntervalMs ?? 120_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const maxPasses = options.maxPasses ?? 10;
  const logger = options.logger ?? noopLogger;
  const clock = sql`clock_timestamp()`;
  const after = (ms: number) => sql`clock_timestamp() + ${`${ms} milliseconds`}::interval`;

  const audit = (
    workflowId: string,
    eventType: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ) =>
    db
      .insert(auditEvents)
      .values({
        workflowId,
        eventType,
        actor: PROVISIONING_ACTOR,
        correlationId: `provisioning:${workflowId}`,
        idempotencyKey,
        payload,
      })
      .onConflictDoNothing();

  async function loadPlan(workflowId: string): Promise<WorkflowProvisioningPlan | undefined> {
    const [plan] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId))
      // ACTIVE first, then the most recently completed.
      .orderBy(asc(workflowProvisioningPlans.status), desc(workflowProvisioningPlans.createdAt));
    return plan;
  }

  /** Only the plan's run: requests from other historical agent runs are never touched. */
  function loadPlanRows(plan: WorkflowProvisioningPlan): Promise<Row[]> {
    return db
      .select({ request: accessRequests, decision: accessDecisions })
      .from(accessRequests)
      .innerJoin(accessDecisions, eq(accessDecisions.id, accessRequests.accessDecisionId))
      .where(
        and(
          eq(accessRequests.workflowId, plan.workflowId),
          eq(accessRequests.agentRunId, plan.agentRunId),
        ),
      );
  }

  function integrityOk(plan: WorkflowProvisioningPlan, rows: Row[]): boolean {
    return rows.every(
      ({ request, decision }) =>
        decision.agentRunId === plan.agentRunId &&
        decision.workflowId === plan.workflowId &&
        decision.resourceId === request.resourceId &&
        decision.catalogVersion === plan.catalogVersion &&
        decision.catalogHash === plan.catalogHash &&
        decision.policyVersion === plan.policyVersion &&
        decision.policyHash === plan.policyHash,
    );
  }

  async function setBlocker(request: AccessRequest, blocker: Blocker) {
    const next =
      blocker.schedule === "RECONCILE"
        ? after(reconcileIntervalMs)
        : blocker.schedule === "FULFILLMENT"
          ? after(fulfillmentReconcileIntervalMs)
          : blocker.schedule === "RETRY"
            ? after(retryDelayMs)
            : null;
    const [updated] = await db
      .update(accessRequests)
      .set({
        orchestrationBlocker: blocker.code,
        blockerClass: blocker.blockerClass,
        nextReconcileAt: next,
        lastCoordinatedAt: clock,
      })
      .where(
        and(
          eq(accessRequests.id, request.id),
          notInArray(accessRequests.status, ["PROVISIONED", "DENIED", "REJECTED"]),
        ),
      )
      .returning();
    if (updated && request.orchestrationBlocker !== blocker.code) {
      await audit(
        request.workflowId,
        "provisioning.blocked",
        `provisioning:${request.id}:blocked:${blocker.code}:v${updated.version}`,
        {
          accessRequestId: request.id,
          resourceId: request.resourceId,
          status: updated.status,
          blocker: blocker.code,
          blockerClass: blocker.blockerClass,
        },
      );
    }
    return updated;
  }

  async function clearBlocker(request: AccessRequest) {
    if (
      request.orchestrationBlocker === null &&
      request.blockerClass === null &&
      request.nextReconcileAt === null
    ) {
      return;
    }
    await db
      .update(accessRequests)
      .set({
        orchestrationBlocker: null,
        blockerClass: null,
        nextReconcileAt: null,
        lastCoordinatedAt: clock,
      })
      .where(eq(accessRequests.id, request.id));
  }

  /** Timed waits (external reconcile, transient retry, another coordinator in flight) aren't due yet. */
  function due(request: AccessRequest): boolean {
    if (!request.nextReconcileAt || request.nextReconcileAt.getTime() <= Date.now()) return true;
    return !(
      request.blockerClass === "RETRYABLE" ||
      SCHEDULED_WAITS.has(request.orchestrationBlocker ?? "") ||
      request.orchestrationBlocker === null
    );
  }

  async function moveToManual(request: AccessRequest): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [moved] = await tx
        .update(accessRequests)
        .set({
          status: "MANUAL_ACTION_REQUIRED",
          orchestrationBlocker: BLOCKERS.MANUAL_ACTION_REQUIRED.code,
          blockerClass: BLOCKERS.MANUAL_ACTION_REQUIRED.blockerClass,
          nextReconcileAt: null,
          lastCoordinatedAt: clock,
          version: sql`${accessRequests.version} + 1`,
          updatedAt: clock,
        })
        .where(
          and(
            eq(accessRequests.id, request.id),
            eq(accessRequests.status, "READY_FOR_PROVISIONING"),
          ),
        )
        .returning();
      if (moved) {
        await tx.insert(auditEvents).values({
          workflowId: request.workflowId,
          eventType: "provisioning.manual_action_required",
          actor: PROVISIONING_ACTOR,
          correlationId: `provisioning:${request.workflowId}`,
          idempotencyKey: `provisioning:${request.id}:manual-action-required`,
          payload: {
            accessRequestId: request.id,
            accessDecisionId: request.accessDecisionId,
            resourceId: request.resourceId,
            provider: "MANUAL",
          },
        });
      }
      return Boolean(moved);
    });
  }

  /** Crash safety: a dispatched request is re-found by the reconciler if this process dies. */
  async function markDispatch(request: AccessRequest, provider: string) {
    await db
      .update(accessRequests)
      .set({ lastCoordinatedAt: clock, nextReconcileAt: after(retryDelayMs) })
      .where(
        and(
          eq(accessRequests.id, request.id),
          inArray(accessRequests.status, ["READY_FOR_PROVISIONING", "PROVISIONING"]),
        ),
      );
    await audit(
      request.workflowId,
      "provisioning.request_dispatched",
      `provisioning:${request.id}:dispatched:v${request.version}`,
      { accessRequestId: request.id, resourceId: request.resourceId, provider },
    );
  }

  async function markPlanComplete(tx: Transaction | Database, plan: WorkflowProvisioningPlan) {
    const [done] = await tx
      .update(workflowProvisioningPlans)
      .set({ status: "COMPLETE", completedAt: clock, nextReconcileAt: null, updatedAt: clock })
      .where(
        and(
          eq(workflowProvisioningPlans.id, plan.id),
          eq(workflowProvisioningPlans.status, "ACTIVE"),
        ),
      )
      .returning();
    if (done) {
      await tx
        .insert(auditEvents)
        .values({
          workflowId: plan.workflowId,
          eventType: "provisioning.plan_completed",
          actor: PROVISIONING_ACTOR,
          correlationId: `provisioning:${plan.workflowId}`,
          idempotencyKey: `provisioning-plan:${plan.id}:completed`,
          payload: { planId: plan.id, agentRunId: plan.agentRunId },
        })
        .onConflictDoNothing();
    }
  }

  /** PROVISIONING → ONBOARDING_GENERATION once per plan, with the plan's completion in the same tx. */
  async function completeWorkflow(plan: WorkflowProvisioningPlan): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const details = await workflows.getWorkflow(plan.workflowId);
      if (!details || details.workflow.state !== "PROVISIONING") return false;
      let applied = false;
      try {
        await workflows.transition(
          {
            workflowId: plan.workflowId,
            to: "ONBOARDING_GENERATION",
            expectedVersion: details.workflow.version,
            actor: PROVISIONING_ACTOR,
            correlationId: `provisioning:${plan.workflowId}`,
            idempotencyKey: `provisioning-plan-complete:${plan.id}`,
          },
          {
            effects: async (tx) => {
              applied = true;
              await markPlanComplete(tx, plan);
            },
          },
        );
        return applied;
      } catch (err) {
        if (err instanceof WorkflowVersionConflictError) continue;
        if (err instanceof InvalidTransitionError) return false;
        throw err;
      }
    }
    return false;
  }

  function summarize(rows: Row[], catalog: ResourceCatalog | null): CoordinatedResource[] {
    return rows
      .map(({ request }) => ({
        accessRequestId: request.id,
        resourceId: request.resourceId,
        provider: catalog?.hasResource(request.resourceId)
          ? catalog.getResource(request.resourceId).provider
          : null,
        status: request.status,
        blocker: request.orchestrationBlocker,
        blockerClass: request.blockerClass,
      }))
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  }

  async function coordinateProvisioning({
    workflowId,
  }: {
    workflowId: string;
  }): Promise<ProvisioningCoordinationResult> {
    const started = Date.now();
    const base = {
      workflowId,
      planId: null,
      agentRunId: null,
      planIssue: null,
      transitioned: false,
      dispatchOrder: [] as string[],
      resources: [] as CoordinatedResource[],
    };
    const details = await workflows.getWorkflow(workflowId);
    const state = details?.workflow.state ?? null;
    if (!state || (!COORDINATED_STATES.includes(state) && state !== "ONBOARDING_GENERATION")) {
      return { ...base, outcome: "NOT_APPLICABLE", workflowState: state };
    }

    let plan = await loadPlan(workflowId);
    if (!plan) {
      if (!COORDINATED_STATES.includes(state)) {
        return { ...base, outcome: "NOT_APPLICABLE", workflowState: state };
      }
      try {
        plan = await adoptLegacyPlan(db, workflowId);
      } catch (err) {
        if (!(err instanceof ProvisioningPlanError)) throw err;
        logger.warn({ workflowId, planIssue: err.code }, "provisioning plan unavailable");
        return { ...base, outcome: "PLAN_BLOCKED", planIssue: err.code, workflowState: state };
      }
    }
    const planBase = { ...base, planId: plan.id, agentRunId: plan.agentRunId };
    const blocked = async (code: PlanIssueCode, rows: Row[], catalog: ResourceCatalog | null) => {
      await audit(
        workflowId,
        "provisioning.plan_blocked",
        `provisioning-plan:${plan.id}:blocked:${code}`,
        {
          planId: plan.id,
          planIssue: code,
        },
      );
      logger.warn({ workflowId, planId: plan.id, planIssue: code }, "provisioning plan blocked");
      return {
        ...planBase,
        outcome: "PLAN_BLOCKED" as const,
        planIssue: code,
        workflowState: state,
        resources: summarize(rows, catalog),
      };
    };

    let catalog: ResourceCatalog;
    try {
      catalog = catalogs.resolve({
        catalogVersion: plan.catalogVersion,
        catalogHash: plan.catalogHash,
      });
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      return blocked("CATALOG_UNAVAILABLE", await loadPlanRows(plan), null);
    }
    if (plan.status === "COMPLETE") {
      return {
        ...planBase,
        outcome: "ALREADY_COMPLETE",
        workflowState: state,
        resources: summarize(await loadPlanRows(plan), catalog),
      };
    }

    const dispatchOrder: string[] = [];
    let continueLater = false;
    for (let pass = 0; pass < maxPasses && !continueLater; pass++) {
      const rows = await loadPlanRows(plan);
      if (!integrityOk(plan, rows)) return blocked("PLAN_INTEGRITY_MISMATCH", rows, catalog);
      const nodes = rows.map((row) => {
        const resource: CatalogResource | null = catalog.hasResource(row.request.resourceId)
          ? catalog.getResource(row.request.resourceId)
          : null;
        return {
          row,
          resource,
          resourceId: row.request.resourceId,
          status: row.request.status,
          dependsOn: resource?.dependsOn ?? [],
        };
      });
      let ordered: typeof nodes;
      try {
        ordered = topologicalOrder(nodes);
      } catch {
        return blocked("PLAN_INTEGRITY_MISMATCH", rows, catalog);
      }
      const statusByResource = new Map(nodes.map((n) => [n.resourceId, n.status]));
      let progress = false;

      for (const node of ordered) {
        const request = node.row.request;
        const status = statusByResource.get(node.resourceId)!;
        if (isSettled(status)) {
          await clearBlocker(request);
          continue;
        }
        const byStatus = statusBlocker(status);
        if (byStatus) {
          if (request.orchestrationBlocker !== byStatus.code) await setBlocker(request, byStatus);
          continue;
        }
        // READY_FOR_PROVISIONING or PROVISIONING.
        if (!node.resource) {
          await setBlocker(request, BLOCKERS.RESOURCE_NOT_IN_CATALOG);
          continue;
        }
        const kind = dispatchKind(node.resource.provider);
        if (kind === "UNSUPPORTED") {
          await setBlocker(request, BLOCKERS.UNSUPPORTED_PROVISIONING_PROVIDER);
          continue;
        }
        const deps = dependencyState(node, statusByResource);
        if (deps.kind !== "SATISFIED") {
          await setBlocker(
            request,
            deps.kind === "MISSING"
              ? BLOCKERS.MISSING_AUTHORIZED_DEPENDENCY
              : deps.kind === "UNSATISFIABLE"
                ? BLOCKERS.DEPENDENCY_NOT_AUTHORIZED
                : BLOCKERS.DEPENDENCIES_NOT_READY,
          );
          continue;
        }
        if (
          request.orchestrationBlocker === BLOCKERS.DEPENDENCIES_NOT_READY.code &&
          node.dependsOn.length > 0
        ) {
          await audit(
            workflowId,
            "provisioning.dependency_satisfied",
            `provisioning:${request.id}:dependency-satisfied`,
            {
              accessRequestId: request.id,
              resourceId: request.resourceId,
              dependsOn: node.dependsOn,
            },
          );
        }
        if (kind === "MANUAL") {
          if (status === "READY_FOR_PROVISIONING" && (await moveToManual(request))) {
            statusByResource.set(node.resourceId, "MANUAL_ACTION_REQUIRED");
            progress = true;
          }
          continue;
        }
        const service =
          kind === "OKTA" ? options.okta : kind === "GITHUB" ? options.github : options.servicenow;
        if (!service) {
          await setBlocker(request, BLOCKERS.PROVIDER_NOT_CONFIGURED);
          continue;
        }
        if (!due(request)) continue;
        if (options.deadlineMs !== undefined && Date.now() - started > options.deadlineMs) {
          continueLater = true;
          break;
        }
        await markDispatch(request, kind);
        dispatchOrder.push(node.resourceId);
        try {
          const result =
            kind === "OKTA"
              ? await options.okta!.provisionOktaAccess({ accessRequestId: request.id })
              : kind === "GITHUB"
                ? await options.github!.provisionGitHubAccess({ accessRequestId: request.id })
                : await options.servicenow!.provisionServiceNowAccess({
                    accessRequestId: request.id,
                  });
          if (result.status === "PROVISIONED") {
            await db
              .update(accessRequests)
              .set({
                orchestrationBlocker: null,
                blockerClass: null,
                nextReconcileAt: null,
                lastCoordinatedAt: clock,
              })
              .where(eq(accessRequests.id, request.id));
            statusByResource.set(node.resourceId, "PROVISIONED");
            progress = true;
          } else {
            await setBlocker(
              request,
              result.status === "FULFILLMENT_PENDING"
                ? BLOCKERS.SERVICENOW_FULFILLMENT_PENDING
                : result.status === "FULFILLMENT_IN_PROGRESS"
                  ? BLOCKERS.SERVICENOW_FULFILLMENT_IN_PROGRESS
                  : BLOCKERS.GITHUB_INVITATION_PENDING,
            );
          }
        } catch (err) {
          const e = err as { code?: unknown; retryable?: unknown; reason?: unknown };
          if (typeof e.code !== "string") throw err; // infrastructure: let the outbox retry
          const blocker = classifyDispatchError({
            code: e.code,
            retryable: e.retryable === true,
            reason: typeof e.reason === "string" ? e.reason : undefined,
          });
          const updated = await setBlocker(request, blocker);
          if (updated) statusByResource.set(node.resourceId, updated.status);
          logger.warn(
            {
              workflowId,
              accessRequestId: request.id,
              resourceId: request.resourceId,
              code: e.code,
            },
            "provisioning dispatch blocked",
          );
        }
      }
      if (!progress) break;
    }

    if (continueLater) {
      await enqueueProvisioningWake(db, {
        workflowId,
        reason: "CONTINUATION",
        key: `continue:${plan.id}:${randomUUID()}`,
      });
    }

    const finalRows = await loadPlanRows(plan);
    const { complete } = completionState(finalRows.map((r) => r.request.status));
    let transitioned = false;
    const latest = (await workflows.getWorkflow(workflowId))!.workflow.state;
    if (complete && latest === "PROVISIONING") {
      transitioned = await completeWorkflow(plan);
    } else if (complete && !COORDINATED_STATES.includes(latest)) {
      await markPlanComplete(db, plan); // the transition committed; reconcile the plan record
    }
    await db
      .update(workflowProvisioningPlans)
      .set({
        lastCoordinatedAt: clock,
        nextReconcileAt: sql`(SELECT min(${accessRequests.nextReconcileAt}) FROM ${accessRequests} WHERE ${accessRequests.workflowId} = ${plan.workflowId} AND ${accessRequests.agentRunId} = ${plan.agentRunId})`,
      })
      .where(
        and(
          eq(workflowProvisioningPlans.id, plan.id),
          eq(workflowProvisioningPlans.status, "ACTIVE"),
        ),
      );
    const workflowState = (await workflows.getWorkflow(workflowId))!.workflow.state;
    const result: ProvisioningCoordinationResult = {
      ...planBase,
      outcome: transitioned
        ? "COMPLETED"
        : complete && !COORDINATED_STATES.includes(workflowState)
          ? "ALREADY_COMPLETE"
          : "IN_PROGRESS",
      workflowState,
      transitioned,
      dispatchOrder,
      resources: summarize(finalRows, catalog),
    };
    logger.info(
      {
        workflowId,
        planId: plan.id,
        agentRunId: plan.agentRunId,
        outcome: result.outcome,
        dispatchOrder,
        unresolved: result.resources.filter((r) => !isSettled(r.status)).length,
        latencyMs: Date.now() - started,
      },
      "provisioning coordinated",
    );
    return result;
  }

  async function enqueueDueWakes({ limit = 100 }: { limit?: number } = {}) {
    const bucket = Math.floor(Date.now() / sweepIntervalMs);
    let enqueued = 0;
    const due = await db
      .selectDistinct({
        planId: workflowProvisioningPlans.id,
        workflowId: workflowProvisioningPlans.workflowId,
      })
      .from(workflowProvisioningPlans)
      .innerJoin(
        accessRequests,
        and(
          eq(accessRequests.workflowId, workflowProvisioningPlans.workflowId),
          eq(accessRequests.agentRunId, workflowProvisioningPlans.agentRunId),
        ),
      )
      .where(
        and(
          eq(workflowProvisioningPlans.status, "ACTIVE"),
          sql`${accessRequests.nextReconcileAt} <= clock_timestamp()`,
          inArray(accessRequests.status, ["READY_FOR_PROVISIONING", "PROVISIONING"]),
        ),
      )
      .limit(limit);
    for (const d of due) {
      if (
        await enqueueProvisioningWake(db, {
          workflowId: d.workflowId,
          reason: "SCHEDULED_RECONCILIATION",
          key: `sweep:${d.planId}:${bucket}`,
        })
      ) {
        enqueued++;
      }
    }
    // Legacy workflows already in a provisioning phase without a plan (adopted or failed closed once).
    const legacy = await db
      .select({ id: onboardingWorkflows.id })
      .from(onboardingWorkflows)
      .where(
        and(
          inArray(onboardingWorkflows.state, [...COORDINATED_STATES]),
          sql`NOT EXISTS (SELECT 1 FROM ${workflowProvisioningPlans} WHERE ${workflowProvisioningPlans.workflowId} = ${onboardingWorkflows.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.workflowId} = ${onboardingWorkflows.id} AND ${auditEvents.eventType} IN ('provisioning.plan_ambiguous', 'provisioning.plan_unavailable'))`,
        ),
      )
      .limit(limit);
    for (const w of legacy) {
      if (
        await enqueueProvisioningWake(db, {
          workflowId: w.id,
          reason: "LEGACY_ADOPTION",
          key: `legacy:${w.id}:${bucket}`,
        })
      ) {
        enqueued++;
      }
    }
    return { enqueued };
  }

  return { coordinateProvisioning, enqueueDueWakes };
}
