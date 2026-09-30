import type { OnboardingPlanModelInput, PlanResource } from "@aoo/agents";
import { CatalogError, type CatalogRegistry, type ResourceCatalog } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  agentRuns,
  employees,
  externalOperations,
  hrisEventReceipts,
  onboardingWorkflows,
  workflowProvisioningPlans,
  type AccessRequest,
  type Database,
  type WorkflowProvisioningPlan,
} from "@aoo/db";
import type { PolicyRegistry } from "@aoo/policy";
import type { DepartmentCode, EmploymentTypeCode, RoleFamilyCode } from "@aoo/shared";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

/** Deterministic reasons a plan can't be generated. Checked before any model call; never retried. */
export type OnboardingContextErrorCode =
  | "WORKFLOW_NOT_FOUND"
  | "PROVISIONING_PLAN_MISSING"
  | "PROVISIONING_PLAN_AMBIGUOUS"
  | "PLAN_WORKFLOW_MISMATCH"
  | "SOURCE_RUN_UNAVAILABLE"
  | "CONTEXT_UNAVAILABLE"
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_HASH_MISMATCH"
  | "POLICY_UNAVAILABLE"
  | "RESOURCE_NOT_IN_CATALOG"
  | "ACCESS_REQUEST_OWNERSHIP_MISMATCH"
  | "ONBOARDING_INPUT_NOT_SETTLED";

export class OnboardingContextError extends Error {
  readonly code: OnboardingContextErrorCode;
  /** Safe details (codes, counts, resource ids); never free text. */
  readonly detail: Record<string, unknown>;

  constructor(code: OnboardingContextErrorCode, message: string, detail = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** Human-readable labels for the canonical facts: display text for the plan, never authorization. */
export const DEPARTMENT_LABELS: Readonly<Record<DepartmentCode, string>> = Object.freeze({
  ENGINEERING: "Engineering",
  PRODUCT: "Product",
  SALES: "Sales",
});
export const ROLE_FAMILY_LABELS: Readonly<Record<RoleFamilyCode, string>> = Object.freeze({
  SOFTWARE_ENGINEER: "Software Engineer",
  SRE: "Site Reliability Engineer",
  ENGINEERING_MANAGER: "Engineering Manager",
  PRODUCT_MANAGER: "Product Manager",
  ACCOUNT_EXECUTIVE: "Account Executive",
});
export const EMPLOYMENT_TYPE_LABELS: Readonly<Record<EmploymentTypeCode, string>> = Object.freeze({
  FULL_TIME: "Full-time employee",
  CONTRACTOR: "Contractor",
});

/** Final states the plan may be built from. Anything else means provisioning isn't settled. */
export const SETTLED_REQUEST_STATUSES = ["PROVISIONED", "DENIED", "REJECTED"] as const;

/**
 * Model-facing availability. DENIED (policy) and REJECTED (human) both become NOT_AVAILABLE: the
 * plan never learns, and so can never reveal, why a resource is unavailable.
 */
export function availabilityOf(status: string): PlanResource["availability"] {
  if (status === "PROVISIONED") return "AVAILABLE";
  if (status === "DENIED" || status === "REJECTED") return "NOT_AVAILABLE";
  throw new Error(`status ${status} is not settled`);
}

/** Every access request settled and none carrying an orchestration blocker. */
export function isSettledForPlanning(
  requests: readonly Pick<AccessRequest, "status" | "orchestrationBlocker">[],
): boolean {
  return requests.every(
    (r) =>
      (SETTLED_REQUEST_STATUSES as readonly string[]).includes(r.status) &&
      r.orchestrationBlocker === null,
  );
}

/** Removes secret-like tokens and URL credentials from HRIS free text before the model sees it. */
export function scrubContextText(text: string, max: number): string | null {
  const out = text
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[removed]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[removed]")
    .replace(/\b(bearer|basic|ssws)\s+[A-Za-z0-9._~+/=-]{10,}/gi, "$1 [removed]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    .trim()
    .slice(0, max)
    .trim();
  return out.length > 0 ? out : null;
}

/** One settled resource, internal view (persisted as the run's resource snapshot). */
export interface SettledResource {
  readonly resourceId: string;
  readonly accessRequestId: string;
  readonly accessDecisionId: string;
  readonly decision: string;
  readonly status: string;
  readonly availability: PlanResource["availability"];
}

export interface OnboardingPlanContext {
  readonly workflowId: string;
  readonly employeeId: string;
  readonly provisioningPlan: WorkflowProvisioningPlan;
  readonly catalog: ResourceCatalog;
  readonly modelInput: OnboardingPlanModelInput;
  readonly resources: readonly SettledResource[];
  /** Validation only (never sent): every resource id of the historical catalog. */
  readonly catalogResourceIds: readonly string[];
  /** Validation only (never sent): internal identifiers that must never appear in plan text. */
  readonly forbiddenTerms: readonly string[];
}

const ReceiptContextSchema = z.object({
  role: z.string(),
  department: z.string(),
  jobDescription: z.string().optional(),
});

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the exact historical onboarding context of a workflow in ONBOARDING_GENERATION: the
 * workflow's provisioning plan (its agent run, catalog and policy versions and hashes), the plan's
 * settled access requests, and resource metadata from THAT catalog release (never the current
 * one). Read-only. Fails closed with OnboardingContextError on any inconsistency.
 */
export async function loadOnboardingPlanContext(
  db: Database,
  deps: { catalogs: CatalogRegistry; policies: PolicyRegistry },
  workflowId: string,
): Promise<OnboardingPlanContext> {
  const [found] = await db
    .select({ workflow: onboardingWorkflows, employee: employees })
    .from(onboardingWorkflows)
    .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
    .where(eq(onboardingWorkflows.id, workflowId));
  if (!found) throw new OnboardingContextError("WORKFLOW_NOT_FOUND", "workflow not found");
  const { employee } = found;

  // 1. The provisioning plan that settled this workflow: exactly one, COMPLETE.
  const plans = await db
    .select()
    .from(workflowProvisioningPlans)
    .where(eq(workflowProvisioningPlans.workflowId, workflowId));
  if (plans.length === 0) {
    throw new OnboardingContextError(
      "PROVISIONING_PLAN_MISSING",
      "workflow has no provisioning plan",
    );
  }
  const complete = plans.filter((p) => p.status === "COMPLETE");
  if (complete.length !== 1 || plans.some((p) => p.status === "ACTIVE")) {
    throw new OnboardingContextError(
      "PROVISIONING_PLAN_AMBIGUOUS",
      "workflow does not have exactly one completed provisioning plan",
      { complete: complete.length, active: plans.filter((p) => p.status === "ACTIVE").length },
    );
  }
  const plan = complete[0]!;

  // 2. The plan's source agent run: same workflow and employee, SUCCEEDED.
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, plan.agentRunId));
  if (!run || run.status !== "SUCCEEDED") {
    throw new OnboardingContextError(
      "SOURCE_RUN_UNAVAILABLE",
      "the plan's agent run is unavailable",
    );
  }
  if (run.workflowId !== workflowId || run.employeeId !== employee.id) {
    throw new OnboardingContextError(
      "PLAN_WORKFLOW_MISMATCH",
      "the provisioning plan's agent run belongs to another workflow or employee",
    );
  }

  // 3. The exact historical catalog and policy.
  let catalog: ResourceCatalog;
  try {
    catalog = deps.catalogs.resolve({
      catalogVersion: plan.catalogVersion,
      catalogHash: plan.catalogHash,
    });
  } catch (err) {
    if (err instanceof CatalogError && err.code === "CATALOG_VERSION_MISMATCH") {
      throw new OnboardingContextError(
        "CATALOG_HASH_MISMATCH",
        `catalog ${plan.catalogVersion} does not match the plan's hash`,
      );
    }
    throw new OnboardingContextError(
      "CATALOG_UNAVAILABLE",
      `catalog ${plan.catalogVersion} is not released`,
    );
  }
  let policyTerms: string[];
  try {
    const policy = deps.policies.resolve({
      policyVersion: plan.policyVersion,
      policyHash: plan.policyHash,
    });
    policyTerms = policy.snapshot().rules.flatMap((r) => [r.ruleId, r.reasonCode]);
  } catch {
    throw new OnboardingContextError(
      "POLICY_UNAVAILABLE",
      `policy ${plan.policyVersion} is not released with the plan's hash`,
    );
  }

  // 4. The plan's access requests and their decisions, with strict ownership checks.
  const rows = await db
    .select({ request: accessRequests, decision: accessDecisions })
    .from(accessRequests)
    .innerJoin(accessDecisions, eq(accessDecisions.id, accessRequests.accessDecisionId))
    .where(eq(accessRequests.agentRunId, plan.agentRunId));
  for (const { request, decision } of rows) {
    const consistent =
      request.workflowId === workflowId &&
      request.employeeId === employee.id &&
      decision.workflowId === workflowId &&
      decision.employeeId === employee.id &&
      decision.agentRunId === plan.agentRunId &&
      decision.resourceId === request.resourceId &&
      decision.catalogVersion === plan.catalogVersion &&
      decision.catalogHash === plan.catalogHash &&
      decision.policyVersion === plan.policyVersion &&
      decision.policyHash === plan.policyHash;
    if (!consistent) {
      throw new OnboardingContextError(
        "ACCESS_REQUEST_OWNERSHIP_MISMATCH",
        "an access request of the plan is inconsistent with its workflow, decision or plan",
        { resourceId: request.resourceId },
      );
    }
  }
  const requests = rows.map((r) => r.request);
  if (!isSettledForPlanning(requests)) {
    const unsettled = requests.filter((r) => !isSettledForPlanning([r]));
    throw new OnboardingContextError(
      "ONBOARDING_INPUT_NOT_SETTLED",
      `${unsettled.length} access request(s) are not settled`,
      {
        unsettled: unsettled
          .map((r) => ({
            resourceId: r.resourceId,
            status: r.status,
            blocker: r.orchestrationBlocker,
          }))
          .sort((a, b) => compare(a.resourceId, b.resourceId)),
      },
    );
  }
  const missing = requests.filter((r) => !catalog.hasResource(r.resourceId));
  if (missing.length > 0) {
    throw new OnboardingContextError(
      "RESOURCE_NOT_IN_CATALOG",
      "a settled resource is not in the plan's catalog release",
      { resourceIds: missing.map((r) => r.resourceId).sort() },
    );
  }

  // 5. Recommendation context from the HRIS receipt that supplied the run's facts.
  const [receipt] = await db
    .select({ payload: hrisEventReceipts.payload })
    .from(hrisEventReceipts)
    .where(eq(hrisEventReceipts.eventId, run.factsHrisEventId));
  const receiptContext = ReceiptContextSchema.safeParse(receipt?.payload);
  if (!receiptContext.success) {
    throw new OnboardingContextError(
      "CONTEXT_UNAVAILABLE",
      "the HRIS receipt that supplied the run's facts is missing or unreadable",
    );
  }
  const department = DEPARTMENT_LABELS[run.departmentCode as DepartmentCode];
  const roleFamily = ROLE_FAMILY_LABELS[run.roleFamilyCode as RoleFamilyCode];
  const employmentType = EMPLOYMENT_TYPE_LABELS[run.employmentType as EmploymentTypeCode];
  if (!department || !roleFamily || !employmentType) {
    throw new OnboardingContextError(
      "CONTEXT_UNAVAILABLE",
      "the run's fact snapshot is not canonical",
    );
  }

  const resources: SettledResource[] = rows
    .map(({ request, decision }) => ({
      resourceId: request.resourceId,
      accessRequestId: request.id,
      accessDecisionId: decision.id,
      decision: decision.decision,
      status: request.status,
      availability: availabilityOf(request.status),
    }))
    .sort((a, b) => compare(a.resourceId, b.resourceId));
  const modelInput: OnboardingPlanModelInput = {
    employee: {
      departmentLabel: department,
      roleFamilyLabel: roleFamily,
      employmentTypeLabel: employmentType,
      jobTitle: scrubContextText(receiptContext.data.role, 200),
      jobDescription: receiptContext.data.jobDescription
        ? scrubContextText(receiptContext.data.jobDescription, 4000)
        : null,
    },
    resources: resources.map((r) => {
      const def = catalog.getResource(r.resourceId);
      return {
        resourceId: r.resourceId,
        displayName: def.displayName,
        description: def.description,
        availability: r.availability,
      };
    }),
  };

  // 6. Internal identifiers the plan text must never contain (validation only).
  const operationIds = requests
    .flatMap((r) => [r.externalOperationId, r.provisioningOperationId])
    .filter((id): id is string => id !== null);
  const operations = operationIds.length
    ? await db
        .select({
          correlationKey: externalOperations.correlationKey,
          externalId: externalOperations.externalId,
          externalReference: externalOperations.externalReference,
        })
        .from(externalOperations)
        .where(inArray(externalOperations.id, operationIds))
    : [];
  const forbiddenTerms = [
    ...new Set(
      [
        workflowId,
        employee.id,
        employee.hrisEmployeeId,
        plan.id,
        plan.agentRunId,
        ...policyTerms,
        ...rows.flatMap(({ request, decision }) => [
          request.id,
          decision.id,
          decision.matchedRuleId,
          decision.reasonCode,
          request.approvalId,
          request.providerSubjectId,
          request.providerTargetId,
          ...operationIds,
        ]),
        ...operations.flatMap((o) => [o.correlationKey, o.externalId, o.externalReference]),
      ].filter((t): t is string => typeof t === "string" && t.length >= 6),
    ),
  ].sort();

  return Object.freeze({
    workflowId,
    employeeId: employee.id,
    provisioningPlan: plan,
    catalog,
    modelInput,
    resources: Object.freeze(resources),
    catalogResourceIds: Object.freeze(catalog.resources.map((r) => r.resourceId)),
    forbiddenTerms: Object.freeze(forbiddenTerms),
  });
}
