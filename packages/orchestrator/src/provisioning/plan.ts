import {
  accessDecisions,
  accessRequests,
  auditEvents,
  workflowProvisioningPlans,
  type Database,
  type Transaction,
  type WorkflowProvisioningPlan,
} from "@aoo/db";
import { and, eq } from "drizzle-orm";
import { enqueueProvisioningWake } from "./wake.js";

export const PROVISIONING_ACTOR = "provisioning-coordinator";

export type PlanIssueCode =
  /** More than one agent run could own a legacy workflow's provisioning: never guess. */
  | "AMBIGUOUS_PROVISIONING_PLAN"
  /** No completed authorization run exists for the workflow. */
  | "NO_AUTHORIZATION_RUN"
  /** A different run already holds the workflow's active plan. */
  | "PROVISIONING_PLAN_CONFLICT"
  /** The run's decisions disagree on catalog/policy versions, or disagree with the plan. */
  | "PLAN_INTEGRITY_MISMATCH"
  /** The plan's exact catalog version/hash isn't released (never substituted). */
  | "CATALOG_UNAVAILABLE";

export class ProvisioningPlanError extends Error {
  constructor(
    readonly code: PlanIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningPlanError";
  }
}

export interface PlanBinding {
  workflowId: string;
  agentRunId: string;
  catalogVersion: string;
  catalogHash: string;
  policyVersion: string;
  policyHash: string;
}

/**
 * Creates (or reuses) the workflow's ACTIVE provisioning plan for exactly `binding.agentRunId`,
 * with its audit event and a wake, inside `tx`. Never replaces another run's active plan.
 */
export async function createProvisioningPlan(
  tx: Transaction,
  binding: PlanBinding,
  createdVia: "AUTHORIZATION" | "LEGACY_ADOPTION",
): Promise<WorkflowProvisioningPlan> {
  const [inserted] = await tx
    .insert(workflowProvisioningPlans)
    .values({ ...binding, createdVia })
    .onConflictDoNothing()
    .returning();
  const [active] = await tx
    .select()
    .from(workflowProvisioningPlans)
    .where(
      and(
        eq(workflowProvisioningPlans.workflowId, binding.workflowId),
        eq(workflowProvisioningPlans.status, "ACTIVE"),
      ),
    );
  const plan =
    active ??
    (
      await tx
        .select()
        .from(workflowProvisioningPlans)
        .where(
          and(
            eq(workflowProvisioningPlans.workflowId, binding.workflowId),
            eq(workflowProvisioningPlans.agentRunId, binding.agentRunId),
          ),
        )
    )[0];
  if (!plan || plan.agentRunId !== binding.agentRunId) {
    throw new ProvisioningPlanError(
      "PROVISIONING_PLAN_CONFLICT",
      "another agent run already holds this workflow's provisioning plan",
    );
  }
  for (const key of ["catalogVersion", "catalogHash", "policyVersion", "policyHash"] as const) {
    if (plan[key] !== binding[key]) {
      throw new ProvisioningPlanError(
        "PLAN_INTEGRITY_MISMATCH",
        `the plan's ${key} differs from the authorization run's`,
      );
    }
  }
  if (inserted) {
    await tx.insert(auditEvents).values({
      workflowId: binding.workflowId,
      eventType: "provisioning.plan_created",
      actor: PROVISIONING_ACTOR,
      correlationId: `provisioning:${binding.workflowId}`,
      idempotencyKey: `provisioning-plan:${plan.id}:created`,
      payload: { planId: plan.id, createdVia, ...binding },
    });
    await enqueueProvisioningWake(tx, {
      workflowId: binding.workflowId,
      reason: createdVia === "AUTHORIZATION" ? "PLAN_CREATED" : "LEGACY_ADOPTION",
      key: `plan:${plan.id}`,
    });
  }
  return plan;
}

/**
 * Legacy adoption (workflows that reached PROVISIONING before plans existed): adopt the single
 * agent run that owns the workflow's authorization, or fail closed. Never picks "the latest".
 */
export async function adoptLegacyPlan(
  db: Database,
  workflowId: string,
): Promise<WorkflowProvisioningPlan> {
  const fromRequests = await db
    .selectDistinct({ agentRunId: accessRequests.agentRunId })
    .from(accessRequests)
    .where(eq(accessRequests.workflowId, workflowId));
  const evaluated = await db
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workflowId, workflowId),
        eq(auditEvents.eventType, "access.policy_evaluated"),
      ),
    );
  const runs = new Set<string>(fromRequests.map((r) => r.agentRunId));
  for (const { payload } of evaluated) {
    if (typeof payload.agentRunId === "string") runs.add(payload.agentRunId);
  }
  if (runs.size === 0) {
    await db
      .insert(auditEvents)
      .values({
        workflowId,
        eventType: "provisioning.plan_unavailable",
        actor: PROVISIONING_ACTOR,
        correlationId: `provisioning:${workflowId}`,
        idempotencyKey: `provisioning:${workflowId}:no-authorization-run`,
        payload: { planIssue: "NO_AUTHORIZATION_RUN" },
      })
      .onConflictDoNothing();
    throw new ProvisioningPlanError("NO_AUTHORIZATION_RUN", "no completed authorization run");
  }
  if (runs.size > 1) {
    await db
      .insert(auditEvents)
      .values({
        workflowId,
        eventType: "provisioning.plan_ambiguous",
        actor: PROVISIONING_ACTOR,
        correlationId: `provisioning:${workflowId}`,
        idempotencyKey: `provisioning:${workflowId}:ambiguous`,
        payload: { candidateAgentRunIds: [...runs].sort() },
      })
      .onConflictDoNothing();
    throw new ProvisioningPlanError(
      "AMBIGUOUS_PROVISIONING_PLAN",
      `${runs.size} agent runs could own this workflow's provisioning; refusing to guess`,
    );
  }
  const [agentRunId] = [...runs] as [string];
  const versions = await db
    .selectDistinct({
      catalogVersion: accessDecisions.catalogVersion,
      catalogHash: accessDecisions.catalogHash,
      policyVersion: accessDecisions.policyVersion,
      policyHash: accessDecisions.policyHash,
    })
    .from(accessDecisions)
    .where(eq(accessDecisions.agentRunId, agentRunId));
  let binding: PlanBinding | undefined;
  if (versions.length === 1) {
    binding = { workflowId, agentRunId, ...versions[0]! };
  } else if (versions.length === 0) {
    // Zero decisions: the completed authorization pass recorded its versions in the audit trail.
    const p = evaluated.find((e) => e.payload.agentRunId === agentRunId)?.payload;
    if (
      p &&
      ["catalogVersion", "catalogHash", "policyVersion", "policyHash"].every(
        (k) => typeof p[k] === "string",
      )
    ) {
      binding = {
        workflowId,
        agentRunId,
        catalogVersion: p.catalogVersion as string,
        catalogHash: p.catalogHash as string,
        policyVersion: p.policyVersion as string,
        policyHash: p.policyHash as string,
      };
    }
  }
  if (!binding) {
    throw new ProvisioningPlanError(
      "PLAN_INTEGRITY_MISMATCH",
      "the authorization run's catalog/policy versions can't be determined unambiguously",
    );
  }
  return db.transaction((tx) => createProvisioningPlan(tx, binding, "LEGACY_ADOPTION"));
}
