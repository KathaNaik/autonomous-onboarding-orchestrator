import { type CatalogRegistry, type ResourceCatalog } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  agentRecommendations,
  agentRuns,
  approvalCallbackEvents,
  approvals,
  auditEvents,
  employees,
  externalIdentities,
  externalIdentityClaims,
  externalOperations,
  hrisEventReceipts,
  onboardingPlanRuns,
  onboardingPlans,
  onboardingWorkflows,
  outboxEvents,
  workflowProvisioningPlans,
  type AccessDecision,
  type AccessRequest,
  type Database,
  type WorkflowProvisioningPlan,
} from "@aoo/db";
import {
  PLAN_PHASE_ORDER,
  ATTENTION_BLOCKER_CLASSES,
  ATTENTION_BLOCKERS,
  ATTENTION_REQUEST_STATUSES,
  WorkflowListQuerySchema,
  type TimelineEntry,
  type WorkflowListResponse,
  type WorkflowObservabilityView,
  type WorkflowSummary,
} from "@aoo/shared";
import { traceIdOf, withSpan } from "@aoo/telemetry";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { scrubText } from "../external-operations/sanitize.js";

/**
 * M9 read models for the internal operator dashboard. Strictly read-only: SELECTs over AOO's own
 * durable records (no provider, model or write call). Every value leaves through an explicit DTO
 * (`@aoo/shared` observability contracts): free text is scrubbed and capped, JSON payloads are
 * reduced to whitelisted scalar keys, and raw rows, request/response bodies, credentials and
 * headers never leave. Historical workflows (before M5C/M6/M7/M8) render with nulls/empty sections.
 */

type Details = Record<string, string | number | boolean | null>;

const SETTLED = new Set(["PROVISIONED", "DENIED", "REJECTED"]);
const IN_PROGRESS = new Set(["READY_FOR_PROVISIONING", "PROVISIONING", "MANUAL_ACTION_REQUIRED"]);

/** Whitelisted keys copied from audit payloads and provider evidence (scalars only). */
const DETAIL_KEYS = [
  "accessDecisionId",
  "accessRequestId",
  "agentRunId",
  "approvalId",
  "attempt",
  "blocker",
  "catalogVersion",
  "category",
  "code",
  "decision",
  "eventId",
  "externalOperationId",
  "githubLogin",
  "matchedRuleId",
  "membershipState",
  "onboardingPlanId",
  "onboardingPlanRunId",
  "operationId",
  "operationType",
  "organization",
  "outcome",
  "planId",
  "policyVersion",
  "promptVersion",
  "provider",
  "providerState",
  "provisioningPlanId",
  "reason",
  "reasonCode",
  "resourceId",
  "result",
  "retryable",
  "servedModel",
  "serviceNowSysId",
  "status",
  "taskCount",
  "teamId",
  "teamSlug",
  "ticketNumber",
  "fulfillmentState",
  "requestKind",
  "via",
  "workflowCreated",
] as const;
const DETAIL_KEY_SET = new Set<string>(DETAIL_KEYS);

const MAX_TEXT = 300;

/** Scrubbed, capped free text (or null). */
export function safeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const out = scrubText(value);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Whitelisted scalar details from a JSON object (audit payload, provider evidence). */
export function safeDetails(input: unknown, keys: ReadonlySet<string> = DETAIL_KEY_SET): Details {
  const out: Details = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!keys.has(key)) continue;
    if (typeof value === "string") out[key] = safeText(value);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const TIMELINE_LABELS: Record<string, string> = {
  "workflow.created": "Workflow created",
  "workflow.transitioned": "Workflow state changed",
  "hris.offer_signed.linked": "HRIS event linked to the active workflow",
  "access.allowed": "Policy allowed a resource",
  "access.denied": "Policy denied a resource",
  "access.approval_required": "Policy requires approval",
  "access.servicenow_requested": "Approval ticket requested",
  "access.policy_evaluated": "Policy evaluation completed",
  "access.approval_verified": "Approval verified (approved)",
  "access.approval_rejected": "Approval verified (rejected)",
  "approval.conflict": "Approval decision conflict",
  "provisioning.plan_created": "Provisioning plan created",
  "provisioning.plan_completed": "Provisioning plan completed",
  "provisioning.request_dispatched": "Provisioning dispatched",
  "provisioning.blocked": "Provisioning blocked",
  "provisioning.manual_action_required": "Manual action required",
  "provisioning.manual_resource_completed": "Manual resource completed by operator",
  "resource.provisioning_started": "Resource provisioning started",
  "resource.provisioned": "Resource provisioned",
  "resource.provisioning_failed": "Resource provisioning failed",
  "github.org_invitation_created": "GitHub organization invitation sent (pending)",
  "github.org_membership_provisioned": "GitHub organization membership active",
  "github.team_membership_provisioned": "GitHub team membership added",
  "okta.identity_created": "Okta identity created",
  "okta.identity_resolved": "Okta identity reused",
  "servicenow.fulfillment_requested": "ServiceNow fulfillment requested",
  "servicenow.fulfillment_pending": "ServiceNow fulfillment pending",
  "servicenow.fulfillment_verified": "ServiceNow fulfillment verified (fulfilled)",
  "servicenow.fulfillment_failed": "ServiceNow fulfillment failed",
  "onboarding_plan.generation_started": "Onboarding plan generation started",
  "onboarding_plan.generated": "Onboarding plan generated",
  "onboarding_plan.generation_failed": "Onboarding plan generation failed",
  "onboarding_plan.generation_blocked": "Onboarding plan generation blocked",
};

/** A readable label for an audit event type (known types, else a humanized form). */
export function timelineLabel(eventType: string, toState?: string | null): string {
  if (eventType === "workflow.transitioned" && toState) return `Workflow → ${toState}`;
  return (
    TIMELINE_LABELS[eventType] ??
    eventType.replace(/[._]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

/** Timeline order: occurredAt (microseconds) ascending, then the stable `<source>:<id>`. */
export function sortTimeline<T extends { occurredAtUs: bigint; id: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    a.occurredAtUs < b.occurredAtUs
      ? -1
      : a.occurredAtUs > b.occurredAtUs
        ? 1
        : compare(a.id, b.id),
  );
}

export type AuthorizationOutcome =
  WorkflowObservabilityView["resources"][number]["authorization"]["outcome"];

/** Authorization outcome of a resource, kept separate from its provisioning status. */
export function authorizationOutcome(
  decision: string,
  status: string,
  via: string | null,
): AuthorizationOutcome {
  if (decision === "DENY") return "DENIED_BY_POLICY";
  if (decision === "ALLOW") return "AUTHORIZED_BY_POLICY";
  if (status === "AWAITING_APPROVAL") return "PENDING_APPROVAL";
  if (status === "REJECTED") return "REJECTED_BY_APPROVER";
  return via === "APPROVAL" || status !== "AWAITING_APPROVAL"
    ? "AUTHORIZED_BY_APPROVAL"
    : "PENDING_APPROVAL";
}

/** Resource progress counts for a set of access-request statuses. */
export function resourceProgress(statuses: readonly string[]) {
  return {
    total: statuses.length,
    settled: statuses.filter((s) => SETTLED.has(s)).length,
    provisioned: statuses.filter((s) => s === "PROVISIONED").length,
    denied: statuses.filter((s) => s === "DENIED").length,
    rejected: statuses.filter((s) => s === "REJECTED").length,
    inProgress: statuses.filter((s) => IN_PROGRESS.has(s) || s === "AWAITING_APPROVAL").length,
    failed: statuses.filter((s) => s === "PROVISIONING_FAILED").length,
  };
}

/** The plan the operator view follows: the ACTIVE one, else the most recently completed. */
export function currentPlan<T extends Pick<WorkflowProvisioningPlan, "status" | "createdAt">>(
  plans: readonly T[],
): T | null {
  const active = plans.find((p) => p.status === "ACTIVE");
  if (active) return active;
  return [...plans].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

type RunLike = { status: string; errorRetryable: boolean | null };
/** Onboarding-plan status for the list: ACCEPTED, FAILED (terminal), GENERATING or NOT_STARTED. */
export function onboardingPlanStatus(hasPlan: boolean, runs: readonly RunLike[]) {
  if (hasPlan) return "ACCEPTED" as const;
  if (runs.some((r) => r.status === "FAILED" && r.errorRetryable === false))
    return "FAILED" as const;
  if (runs.length > 0) return "GENERATING" as const;
  return "NOT_STARTED" as const;
}

const CursorSchema = z.object({ u: z.string().max(64), i: z.uuid() });
export function encodeCursor(updatedAtText: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAtText, i: id })).toString("base64url");
}
export function decodeCursor(cursor: string): { u: string; i: string } | null {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    if (!parsed.success || Number.isNaN(Date.parse(parsed.data.u))) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export class ReadModelError extends Error {
  constructor(
    readonly code: "WORKFLOW_NOT_FOUND" | "INVALID_QUERY",
    message: string,
  ) {
    super(message);
    this.name = "ReadModelError";
  }
}

const ReceiptContextSchema = z.object({ role: z.string(), department: z.string() });

export interface WorkflowReadService {
  listWorkflows(query?: unknown): Promise<WorkflowListResponse>;
  getWorkflowObservabilityView(workflowId: string): Promise<WorkflowObservabilityView>;
}

export function createWorkflowReadService(
  db: Database,
  deps: { catalogs: CatalogRegistry },
): WorkflowReadService {
  const catalogFor = (
    version: string | undefined,
    hash: string | undefined,
  ): ResourceCatalog | null => {
    if (!version) return null;
    try {
      return hash
        ? deps.catalogs.resolve({ catalogVersion: version, catalogHash: hash })
        : deps.catalogs.get(version);
    } catch {
      try {
        return deps.catalogs.get(version);
      } catch {
        return null;
      }
    }
  };
  const nameOf = (catalog: ResourceCatalog | null, resourceId: string) =>
    catalog?.hasResource(resourceId) ? catalog.getResource(resourceId).displayName : null;

  /** (M13 UI) Counts over all workflows, one query (the attention rule is shared with the console). */
  async function listSummary(): Promise<WorkflowListResponse["summary"]> {
    const statuses = sql.join(
      ATTENTION_REQUEST_STATUSES.map((v) => sql`${v}`),
      sql`, `,
    );
    const blockers = sql.join(
      ATTENTION_BLOCKERS.map((v) => sql`${v}`),
      sql`, `,
    );
    const classes = sql.join(
      ATTENTION_BLOCKER_CLASSES.map((v) => sql`${v}`),
      sql`, `,
    );
    const w = onboardingWorkflows;
    const open = sql`onboarding_workflows.state::text NOT IN ('COMPLETED', 'FAILED')`;
    const rows = await db
      .select({
        total: sql<number>`count(*)::int`,
        inProgress: sql<number>`count(*) FILTER (WHERE ${open})::int`,
        completed: sql<number>`count(*) FILTER (WHERE onboarding_workflows.state::text = 'COMPLETED')::int`,
        failed: sql<number>`count(*) FILTER (WHERE onboarding_workflows.state::text = 'FAILED')::int`,
        needsAttention: sql<number>`count(*) FILTER (WHERE onboarding_workflows.state::text = 'FAILED' OR (${open} AND EXISTS (
          SELECT 1 FROM access_requests ar
          JOIN workflow_provisioning_plans p
            ON p.workflow_id = ar.workflow_id AND p.agent_run_id = ar.agent_run_id
           AND p.status::text = 'ACTIVE'
          WHERE ar.workflow_id = onboarding_workflows.id
            AND ar.status::text NOT IN ('PROVISIONED', 'DENIED', 'REJECTED')
            AND (ar.status::text IN (${statuses})
              OR ar.orchestration_blocker::text IN (${blockers})
              OR ar.blocker_class::text IN (${classes})))))::int`,
      })
      .from(w);
    return rows[0] ?? { total: 0, inProgress: 0, needsAttention: 0, completed: 0, failed: 0 };
  }

  async function listWorkflows(rawQuery: unknown = {}): Promise<WorkflowListResponse> {
    const parsed = WorkflowListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new ReadModelError("INVALID_QUERY", "invalid list query");
    const { limit, cursor, state, q } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new ReadModelError("INVALID_QUERY", "invalid cursor");
    return withSpan("read_model.workflow_list", {}, async () => {
      const conditions: SQL[] = [];
      if (state) conditions.push(eq(onboardingWorkflows.state, state));
      if (q) {
        // Literal match: LIKE wildcards in the search text are escaped.
        const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const prefix = `${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(
          sql`(lower(${employees.firstName} || ' ' || ${employees.lastName}) LIKE ${like}
            OR lower(${employees.email}) LIKE ${like}
            OR lower(${employees.hrisEmployeeId}) LIKE ${like}
            OR ${onboardingWorkflows.id}::text LIKE ${prefix})`,
        );
      }
      if (after) {
        conditions.push(
          sql`(${onboardingWorkflows.updatedAt}, ${onboardingWorkflows.id}) < (${after.u}::timestamptz, ${after.i}::uuid)`,
        );
      }
      const [rows, summary] = await Promise.all([
        db
          .select({
            workflow: onboardingWorkflows,
            employee: employees,
            updatedAtText: sql<string>`${onboardingWorkflows.updatedAt}::text`,
            jobTitle: sql<string | null>`${hrisEventReceipts.payload}->>'role'`,
          })
          .from(onboardingWorkflows)
          .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
          .leftJoin(hrisEventReceipts, eq(hrisEventReceipts.eventId, employees.factsHrisEventId))
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(onboardingWorkflows.updatedAt), desc(onboardingWorkflows.id))
          .limit(limit + 1),
        listSummary(),
      ]);
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.workflow.id);
      if (ids.length === 0) return { items: [], summary, nextCursor: null };

      // Batched per page (fixed query count, no per-row queries).
      const [plans, planRows, runRows] = await Promise.all([
        db
          .select()
          .from(workflowProvisioningPlans)
          .where(inArray(workflowProvisioningPlans.workflowId, ids)),
        db
          .select({ workflowId: onboardingPlans.workflowId })
          .from(onboardingPlans)
          .where(inArray(onboardingPlans.workflowId, ids)),
        db
          .select({
            workflowId: onboardingPlanRuns.workflowId,
            status: onboardingPlanRuns.status,
            errorRetryable: onboardingPlanRuns.errorRetryable,
          })
          .from(onboardingPlanRuns)
          .where(inArray(onboardingPlanRuns.workflowId, ids)),
      ]);
      const current = new Map<string, WorkflowProvisioningPlan>();
      for (const id of ids) {
        const p = currentPlan(plans.filter((x) => x.workflowId === id));
        if (p) current.set(id, p);
      }
      const runIds = [...new Set([...current.values()].map((p) => p.agentRunId))];
      const requests = runIds.length
        ? await db
            .select({
              workflowId: accessRequests.workflowId,
              agentRunId: accessRequests.agentRunId,
              resourceId: accessRequests.resourceId,
              status: accessRequests.status,
              blocker: accessRequests.orchestrationBlocker,
              blockerClass: accessRequests.blockerClass,
            })
            .from(accessRequests)
            .where(
              and(
                inArray(accessRequests.workflowId, ids),
                inArray(accessRequests.agentRunId, runIds),
              ),
            )
        : [];

      const items: WorkflowSummary[] = page.map(({ workflow, employee, jobTitle }) => {
        const plan = current.get(workflow.id) ?? null;
        const planCatalog = plan ? catalogFor(plan.catalogVersion, plan.catalogHash) : null;
        const reqs = plan
          ? requests
              .filter((r) => r.workflowId === workflow.id && r.agentRunId === plan.agentRunId)
              .sort((a, b) => compare(a.resourceId, b.resourceId))
          : [];
        return {
          workflowId: workflow.id,
          state: workflow.state,
          employee: {
            hrisEmployeeId: employee.hrisEmployeeId,
            displayName: safeText(`${employee.firstName} ${employee.lastName}`, 300) ?? "",
            jobTitle: safeText(jobTitle, 300),
            facts:
              employee.departmentCode && employee.roleFamilyCode && employee.employmentType
                ? {
                    departmentCode: employee.departmentCode,
                    roleFamilyCode: employee.roleFamilyCode,
                    employmentType: employee.employmentType,
                  }
                : null,
          },
          createdAt: iso(workflow.createdAt),
          updatedAt: iso(workflow.updatedAt),
          completedAt: isoOrNull(workflow.completedAt),
          failureReason: safeText(workflow.failureReason, 500),
          provisioningPlanStatus: plan?.status ?? null,
          onboardingPlanStatus: onboardingPlanStatus(
            planRows.some((p) => p.workflowId === workflow.id),
            runRows.filter((r) => r.workflowId === workflow.id),
          ),
          resourceProgress: resourceProgress(reqs.map((r) => r.status)),
          blockers: reqs
            .filter((r) => !SETTLED.has(r.status))
            .slice(0, 5)
            .map((r) => ({
              resourceId: r.resourceId,
              displayName: nameOf(planCatalog, r.resourceId),
              status: r.status,
              blocker: r.blocker,
              blockerClass: r.blockerClass,
            })),
        };
      });
      const last = page[page.length - 1]!;
      return {
        items,
        summary,
        nextCursor: rows.length > limit ? encodeCursor(last.updatedAtText, last.workflow.id) : null,
      };
    });
  }

  async function getWorkflowObservabilityView(
    workflowId: string,
  ): Promise<WorkflowObservabilityView> {
    if (!z.uuid().safeParse(workflowId).success) {
      throw new ReadModelError("WORKFLOW_NOT_FOUND", "workflow not found");
    }
    return withSpan("read_model.workflow_detail", { workflowId }, () => buildView(workflowId));
  }

  async function buildView(workflowId: string): Promise<WorkflowObservabilityView> {
    const [found] = await db
      .select({ workflow: onboardingWorkflows, employee: employees })
      .from(onboardingWorkflows)
      .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
      .where(eq(onboardingWorkflows.id, workflowId));
    if (!found) throw new ReadModelError("WORKFLOW_NOT_FOUND", "workflow not found");
    const { workflow, employee } = found;
    const notes: string[] = [];
    const usCol = (col: SQL | typeof auditEvents.occurredAt) =>
      sql<string>`(extract(epoch from ${col}) * 1000000)::bigint::text`;

    // Workflow-scoped reads (independent; fixed count).
    const [
      receipts,
      runs,
      plans,
      approvalRows,
      audits,
      outbox,
      planRuns,
      acceptedRows,
      identities,
      claims,
    ] = await Promise.all([
      db
        .select({ receipt: hrisEventReceipts, us: usCol(hrisEventReceipts.receivedAt as never) })
        .from(hrisEventReceipts)
        .where(eq(hrisEventReceipts.workflowId, workflowId))
        .orderBy(asc(hrisEventReceipts.receivedAt), asc(hrisEventReceipts.id)),
      db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.workflowId, workflowId), eq(agentRuns.agent, "role-access")))
        .orderBy(desc(agentRuns.startedAt)),
      db
        .select()
        .from(workflowProvisioningPlans)
        .where(eq(workflowProvisioningPlans.workflowId, workflowId)),
      db
        .select()
        .from(approvals)
        .where(eq(approvals.workflowId, workflowId))
        .orderBy(asc(approvals.createdAt)),
      db
        .select({ event: auditEvents, us: usCol(auditEvents.occurredAt) })
        .from(auditEvents)
        .where(eq(auditEvents.workflowId, workflowId)),
      db
        .select({
          id: outboxEvents.id,
          eventType: outboxEvents.eventType,
          status: outboxEvents.status,
          attempts: outboxEvents.attempts,
          createdAt: outboxEvents.createdAt,
          publishedAt: outboxEvents.publishedAt,
          correlationId: outboxEvents.correlationId,
          traceParent: outboxEvents.traceParent,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, workflowId))
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id)),
      db
        .select()
        .from(onboardingPlanRuns)
        .where(eq(onboardingPlanRuns.workflowId, workflowId))
        .orderBy(desc(onboardingPlanRuns.startedAt)),
      db.select().from(onboardingPlans).where(eq(onboardingPlans.workflowId, workflowId)),
      db.select().from(externalIdentities).where(eq(externalIdentities.employeeId, employee.id)),
      db
        .select()
        .from(externalIdentityClaims)
        .where(eq(externalIdentityClaims.employeeId, employee.id)),
    ]);

    const plan = currentPlan(plans);
    const run = (plan && runs.find((r) => r.id === plan.agentRunId)) ?? runs[0] ?? null;
    if (!run) notes.push("No Role Access Agent run yet (not reached).");
    if (!plan) notes.push("No provisioning plan yet (not reached).");
    if (!employee.departmentCode)
      notes.push("Employee has no canonical facts (created before M5C).");

    // Run-scoped reads (fixed count).
    const [recommendations, decisions, requests] = run
      ? await Promise.all([
          db
            .select()
            .from(agentRecommendations)
            .where(eq(agentRecommendations.agentRunId, run.id))
            .orderBy(asc(agentRecommendations.resourceId)),
          db
            .select()
            .from(accessDecisions)
            .where(eq(accessDecisions.agentRunId, run.id))
            .orderBy(asc(accessDecisions.resourceId)),
          db
            .select()
            .from(accessRequests)
            .where(
              and(eq(accessRequests.workflowId, workflowId), eq(accessRequests.agentRunId, run.id)),
            )
            .orderBy(asc(accessRequests.resourceId)),
        ])
      : [[], [] as AccessDecision[], [] as AccessRequest[]];

    const opIds = [
      ...new Set(
        requests
          .flatMap((r) => [r.externalOperationId, r.provisioningOperationId])
          .filter((x): x is string => !!x),
      ),
    ];
    const [operations, callbacks] = await Promise.all([
      db
        .select()
        .from(externalOperations)
        .where(
          opIds.length
            ? or(
                eq(externalOperations.workflowId, workflowId),
                inArray(externalOperations.id, opIds),
              )
            : eq(externalOperations.workflowId, workflowId),
        )
        .orderBy(asc(externalOperations.createdAt), asc(externalOperations.id)),
      db
        .select({
          approvalId: approvalCallbackEvents.approvalId,
          status: approvalCallbackEvents.status,
          outcome: approvalCallbackEvents.outcome,
          receivedAt: approvalCallbackEvents.receivedAt,
        })
        .from(approvalCallbackEvents)
        .innerJoin(approvals, eq(approvals.id, approvalCallbackEvents.approvalId))
        .where(eq(approvals.workflowId, workflowId)),
    ]);

    const catalog = catalogFor(
      plan?.catalogVersion ?? run?.catalogVersion,
      plan?.catalogHash ?? run?.catalogHash,
    );
    if (run && !catalog)
      notes.push("The run's catalog release is not available; display names are omitted.");

    // Employee display context from the HRIS receipt that supplied the facts (never the raw body).
    const factsReceipt =
      receipts.find((r) => r.receipt.eventId === employee.factsHrisEventId) ??
      receipts[receipts.length - 1];
    const context = ReceiptContextSchema.safeParse(factsReceipt?.receipt.payload);

    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    const requestByResource = new Map(requests.map((r) => [r.resourceId, r]));
    const requestForOp = (opId: string, key: string) =>
      requests.find(
        (r) =>
          r.externalOperationId === opId ||
          r.provisioningOperationId === opId ||
          key.includes(`request=${r.id}`),
      ) ?? null;

    const resources = requests.map((r) => {
      const decision = decisionById.get(r.accessDecisionId);
      const def = catalog?.hasResource(r.resourceId) ? catalog.getResource(r.resourceId) : null;
      return {
        accessRequestId: r.id,
        resourceId: r.resourceId,
        displayName: def?.displayName ?? null,
        provider: def?.provider ?? null,
        catalogVersion:
          decision?.catalogVersion ?? plan?.catalogVersion ?? run?.catalogVersion ?? "unknown",
        authorization: {
          decision: (decision?.decision ?? "ALLOW") as "ALLOW" | "DENY" | "REQUIRES_APPROVAL",
          outcome: authorizationOutcome(decision?.decision ?? "ALLOW", r.status, r.authorizedVia),
          via: r.authorizedVia,
        },
        status: r.status,
        settled: SETTLED.has(r.status),
        dependsOn: (def?.dependsOn ?? []).map((dep) => ({
          resourceId: dep,
          status: requestByResource.get(dep)?.status ?? null,
        })),
        blocker: r.orchestrationBlocker,
        blockerClass: r.blockerClass,
        providerState: r.providerState,
        lastCoordinatedAt: isoOrNull(r.lastCoordinatedAt),
        nextReconcileAt: isoOrNull(r.nextReconcileAt),
        provisionedAt: isoOrNull(r.provisionedAt),
        provisioningErrorCode: r.provisioningErrorCode,
        evidence: {
          ...safeDetails(r.providerEvidence),
          ...(r.providerSubjectId && { providerSubjectId: safeText(r.providerSubjectId) }),
          ...(r.providerTargetId && { providerTargetId: safeText(r.providerTargetId) }),
          ...(r.provisioningOperationId && { provisioningOperationId: r.provisioningOperationId }),
          ...(r.manualCompletedBy && { manualCompletedBy: safeText(r.manualCompletedBy) }),
          ...(r.manualEvidence && { manualEvidence: safeText(r.manualEvidence) }),
        },
      };
    });

    const fulfillmentOps = operations.filter(
      (o) => o.operationType === "servicenow.create_fulfillment_request",
    );
    const fulfillments = requests
      .filter((r) => {
        const provider = catalog?.hasResource(r.resourceId)
          ? catalog.getResource(r.resourceId).provider
          : null;
        return (
          provider === "SERVICENOW" &&
          !["DENIED", "REJECTED", "AWAITING_APPROVAL"].includes(r.status)
        );
      })
      .map((r) => {
        const op =
          fulfillmentOps.find(
            (o) =>
              o.id === r.provisioningOperationId || o.idempotencyKey.includes(`request=${r.id}`),
          ) ?? null;
        const ev = safeDetails(r.providerEvidence);
        return {
          resourceId: r.resourceId,
          accessRequestId: r.id,
          externalOperationId: op?.id ?? null,
          operationStatus: op?.status ?? null,
          requestKind: "fulfillment" as const,
          ticketNumber:
            (ev.ticketNumber as string | null | undefined) ?? op?.externalReference ?? null,
          sysId: (ev.serviceNowSysId as string | null | undefined) ?? op?.externalId ?? null,
          // M7D records an authoritative "failed" read-back as this error code (+ audit event);
          // the request's evidence keeps the last non-final snapshot, so derive it here.
          fulfillmentState:
            r.provisioningErrorCode === "SERVICENOW_FULFILLMENT_FAILED"
              ? "failed"
              : ((ev.fulfillmentState as string | null | undefined) ?? null),
          requestedAt: isoOrNull(op?.createdAt),
          verifiedFulfilledAt: r.status === "PROVISIONED" ? isoOrNull(r.provisionedAt) : null,
          localStatus: r.status,
        };
      });

    const approvalsView = approvalRows.map((a) => {
      const req =
        requests.find(
          (r) => r.approvalId === a.id || r.externalOperationId === a.externalOperationId,
        ) ?? null;
      const cbs = callbacks
        .filter((c) => c.approvalId === a.id)
        .sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
      return {
        approvalId: a.id,
        resourceId: req?.resourceId ?? null,
        accessRequestId: req?.id ?? null,
        externalOperationId: a.externalOperationId,
        ticketNumber: a.externalReference,
        sysId: a.externalId,
        status: a.status,
        providerState: a.providerState,
        requestedAt: iso(a.createdAt),
        verifiedAt: isoOrNull(a.verifiedAt),
        decidedAt: isoOrNull(a.decidedAt),
        callbacks: {
          received: cbs.length,
          processed: cbs.filter((c) => c.status === "PROCESSED").length,
          rejected: cbs.filter((c) => c.status === "REJECTED").length,
          lastOutcome: cbs.length ? (cbs[cbs.length - 1]!.outcome ?? null) : null,
        },
      };
    });

    const externalOperationsView = operations.map((o) => {
      const req = requestForOp(o.id, o.idempotencyKey);
      return {
        operationId: o.id,
        provider: o.provider,
        operationType: o.operationType,
        keySummary:
          o.idempotencyKey.length > 120 ? `${o.idempotencyKey.slice(0, 119)}…` : o.idempotencyKey,
        correlationKey: o.correlationKey,
        status: o.status,
        attempts: o.attempts,
        externalReference: o.externalReference,
        createdAt: iso(o.createdAt),
        updatedAt: iso(o.updatedAt),
        completedAt: isoOrNull(o.completedAt),
        lastError: safeText(o.lastError, 500),
        resourceId: req?.resourceId ?? null,
        accessRequestId: req?.id ?? null,
      };
    });

    const latestPlanRun = planRuns[0] ?? null;
    const accepted = acceptedRows[0] ?? null;
    const acceptedRun = accepted
      ? (planRuns.find((r) => r.id === accepted.onboardingPlanRunId) ?? null)
      : null;
    const shownRun = acceptedRun ?? latestPlanRun;
    if (!shownRun && !accepted) notes.push("No onboarding plan yet (not reached).");
    type PlanTask = {
      phase?: unknown;
      category?: unknown;
      title?: unknown;
      instruction?: unknown;
      resourceIds?: unknown;
    };
    const planTasks = (accepted?.tasks ?? []) as PlanTask[];
    const phases = [...new Set([...PLAN_PHASE_ORDER, ...planTasks.map((t) => String(t.phase))])]
      .map((phase) => ({
        phase,
        tasks: planTasks
          .filter((t) => String(t.phase) === phase)
          .map((t) => ({
            category: String(t.category),
            title: safeText(t.title, 200) ?? "",
            instruction: safeText(t.instruction, 1000) ?? "",
            resources: (Array.isArray(t.resourceIds) ? t.resourceIds : [])
              .filter((x): x is string => typeof x === "string")
              .map((resourceId) => ({ resourceId, displayName: nameOf(catalog, resourceId) })),
          })),
      }))
      .filter((p) => p.tasks.length > 0);

    const timeline = sortTimeline([
      ...receipts.map(({ receipt, us }) => ({
        id: `hris:${receipt.id}`,
        occurredAtUs: BigInt(us),
        source: "HRIS" as const,
        occurredAt: iso(receipt.receivedAt),
        type: `hris.${receipt.eventType}`,
        label: `HRIS ${receipt.eventType} accepted`,
        actor: "hris-webhook",
        fromState: null,
        toState: null,
        details: { eventId: safeText(receipt.eventId), workflowCreated: receipt.workflowCreated },
      })),
      ...audits.map(({ event, us }) => ({
        id: `audit:${event.id}`,
        occurredAtUs: BigInt(us),
        source: "AUDIT" as const,
        occurredAt: iso(event.occurredAt),
        type: event.eventType,
        label: timelineLabel(event.eventType, event.toState),
        actor: safeText(event.actor, 100),
        fromState: event.fromState,
        toState: event.toState,
        details: safeDetails(event.payload),
      })),
    ]).map(({ occurredAtUs: _omit, ...entry }): TimelineEntry => entry);

    const correlationIds = [
      ...new Set(
        [...audits.map((a) => a.event.correlationId), ...outbox.map((o) => o.correlationId)].filter(
          (x): x is string => !!x,
        ),
      ),
    ].sort();

    const view: WorkflowObservabilityView = {
      generatedAt: new Date().toISOString(),
      workflow: {
        workflowId: workflow.id,
        state: workflow.state,
        version: workflow.version,
        createdAt: iso(workflow.createdAt),
        updatedAt: iso(workflow.updatedAt),
        completedAt: isoOrNull(workflow.completedAt),
        failureReason: safeText(workflow.failureReason, 500),
      },
      employee: {
        hrisEmployeeId: employee.hrisEmployeeId,
        displayName: safeText(`${employee.firstName} ${employee.lastName}`, 300) ?? "",
        workEmail: employee.email,
        facts:
          employee.departmentCode && employee.roleFamilyCode && employee.employmentType
            ? {
                departmentCode: employee.departmentCode,
                roleFamilyCode: employee.roleFamilyCode,
                employmentType: employee.employmentType,
              }
            : null,
        factsSourceEventId: employee.factsHrisEventId,
        jobTitle: context.success ? safeText(context.data.role) : null,
        departmentDisplay: context.success ? safeText(context.data.department) : null,
      },
      hrisEvents: receipts.map(({ receipt }) => ({
        eventId: receipt.eventId,
        eventType: receipt.eventType,
        receivedAt: iso(receipt.receivedAt),
        workflowCreated: receipt.workflowCreated,
      })),
      roleAccessRun: run
        ? {
            agentRunId: run.id,
            status: run.status,
            promptVersion: run.promptVersion,
            modelProvider: run.modelProvider,
            model: run.model,
            servedModel: run.servedModel,
            catalogVersion: run.catalogVersion,
            catalogHash: run.catalogHash,
            attempts: run.attempts,
            modelCalls: run.modelCalls,
            startedAt: iso(run.startedAt),
            completedAt: isoOrNull(run.completedAt),
            latencyMs: run.latencyMs,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            error: run.errorCategory
              ? {
                  category: run.errorCategory,
                  message: safeText(run.errorMessage, 500) ?? "",
                  retryable: run.errorRetryable,
                }
              : null,
            recommendations: recommendations.map((r) => ({
              resourceId: r.resourceId,
              displayName: nameOf(catalog, r.resourceId),
              reasonCode: r.reasonCode,
              reason: safeText(r.reason, 500) ?? "",
              confidence: r.confidence,
            })),
            otherRunCount: runs.length - 1,
          }
        : null,
      policyDecisions: decisions.map((d) => ({
        accessDecisionId: d.id,
        resourceId: d.resourceId,
        displayName: nameOf(catalog, d.resourceId),
        decision: d.decision,
        policyVersion: d.policyVersion,
        policyHash: d.policyHash,
        catalogVersion: d.catalogVersion,
        matchedRuleId: d.matchedRuleId,
        reasonCode: d.reasonCode,
        explanation: safeText(d.explanation, 1000) ?? "",
        decidedAt: iso(d.createdAt),
      })),
      provisioningPlan: plan
        ? {
            planId: plan.id,
            status: plan.status,
            createdVia: plan.createdVia,
            agentRunId: plan.agentRunId,
            catalogVersion: plan.catalogVersion,
            catalogHash: plan.catalogHash,
            policyVersion: plan.policyVersion,
            policyHash: plan.policyHash,
            createdAt: iso(plan.createdAt),
            completedAt: isoOrNull(plan.completedAt),
            lastCoordinatedAt: isoOrNull(plan.lastCoordinatedAt),
            nextReconcileAt: isoOrNull(plan.nextReconcileAt),
          }
        : null,
      resources,
      approvals: approvalsView,
      fulfillments,
      identities: identities.map((i) => ({
        provider: i.provider,
        providerSubjectId: i.providerSubjectId,
        login: safeText(i.providerLogin),
        linkedAt: iso(i.createdAt),
        verifiedAt: isoOrNull(i.verifiedAt),
      })),
      githubClaim: (() => {
        const c = claims.find((x) => x.provider === "github");
        return c
          ? {
              login: c.claimedLogin,
              source: c.source,
              recordedBy: safeText(c.recordedBy, 100),
              recordedAt: iso(c.updatedAt),
            }
          : null;
      })(),
      externalOperations: externalOperationsView,
      onboardingPlanRun: shownRun
        ? {
            runId: shownRun.id,
            status: shownRun.status,
            promptVersion: shownRun.promptVersion,
            model: shownRun.model,
            servedModel: shownRun.servedModel,
            attempts: shownRun.attempts,
            modelCalls: shownRun.modelCalls,
            startedAt: iso(shownRun.startedAt),
            completedAt: isoOrNull(shownRun.completedAt),
            latencyMs: shownRun.latencyMs,
            inputTokens: shownRun.inputTokens,
            outputTokens: shownRun.outputTokens,
            error: shownRun.errorCategory
              ? {
                  category: shownRun.errorCategory,
                  message: safeText(shownRun.errorMessage, 500) ?? "",
                  retryable: shownRun.errorRetryable,
                }
              : null,
            otherRunCount: planRuns.length - 1,
          }
        : null,
      onboardingPlan: accepted
        ? {
            planId: accepted.id,
            runId: accepted.onboardingPlanRunId,
            promptVersion: accepted.promptVersion,
            servedModel: acceptedRun?.servedModel ?? null,
            createdAt: iso(accepted.createdAt),
            summary: safeText(accepted.summary, 1000) ?? "",
            taskCount: accepted.taskCount,
            phases,
          }
        : null,
      timeline,
      correlation: {
        correlationIds,
        traceIds: [
          ...new Set(outbox.map((o) => traceIdOf(o.traceParent)).filter((x): x is string => !!x)),
        ],
        outboxEvents: outbox.map((o) => ({
          eventId: o.id,
          eventType: o.eventType,
          status: o.status,
          attempts: o.attempts,
          createdAt: iso(o.createdAt),
          publishedAt: isoOrNull(o.publishedAt),
          traceId: traceIdOf(o.traceParent),
        })),
        providerCorrelationKeys: [...new Set(operations.map((o) => o.correlationKey))].sort(),
      },
      notes,
    };
    return view;
  }

  return { listWorkflows, getWorkflowObservabilityView };
}
