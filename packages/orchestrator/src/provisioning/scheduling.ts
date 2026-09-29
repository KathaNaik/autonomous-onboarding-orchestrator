import type { CatalogResource } from "@aoo/catalog";
import type { AccessRequest } from "@aoo/db";

// M7C: pure scheduling rules for the provisioning coordinator (no I/O).

export type RequestStatus = AccessRequest["status"];
export type BlockerClass = "WAITING" | "RETRYABLE" | "MANUAL" | "DETERMINISTIC_FAILURE";

/** Settled authorization or provisioning outcomes: nothing left to do for the resource. */
export const SETTLED_STATUSES: readonly RequestStatus[] = ["PROVISIONED", "DENIED", "REJECTED"];
export const isSettled = (status: RequestStatus) => SETTLED_STATUSES.includes(status);

/** How the coordinator executes a catalog provider. Anything unknown is UNSUPPORTED, never MANUAL. */
export type DispatchKind = "OKTA" | "GITHUB" | "SERVICENOW" | "MANUAL" | "UNSUPPORTED";
export function dispatchKind(provider: CatalogResource["provider"] | string): DispatchKind {
  switch (provider) {
    case "OKTA":
    case "GITHUB":
    case "SERVICENOW": // M7D: human fulfillment through a dedicated ServiceNow record
    case "MANUAL":
      return provider;
    default:
      return "UNSUPPORTED";
  }
}

export interface PlanNode {
  resourceId: string;
  status: RequestStatus;
  dependsOn: readonly string[];
}

/**
 * Dependencies first, ties by resource id (deterministic whatever the input order). Only edges
 * between nodes in the plan are ordered; a dependency missing from the plan is reported by
 * dependencyState. Throws on a cycle (released catalogs are acyclic, so that is an integrity error).
 */
export function topologicalOrder<T extends PlanNode>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.resourceId, n]));
  const indegree = new Map(nodes.map((n) => [n.resourceId, 0]));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const dep of new Set(n.dependsOn)) {
      if (!byId.has(dep)) continue;
      indegree.set(n.resourceId, indegree.get(n.resourceId)! + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), n.resourceId]);
    }
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  const out: T[] = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (out.length !== nodes.length) throw new Error("dependency cycle in provisioning plan");
  return out;
}

export type DependencyState =
  | { kind: "SATISFIED" }
  /** Dependencies authorized in the plan but not PROVISIONED yet. */
  | { kind: "WAITING"; pending: string[] }
  /** Declared dependencies with no access request in the plan: authorization is never invented. */
  | { kind: "MISSING"; missing: string[] }
  /** Dependencies that were DENIED or REJECTED: can never be satisfied. */
  | { kind: "UNSATISFIABLE"; blocked: string[] };

/** Satisfied only when every declared dependency's request in the SAME plan is PROVISIONED. */
export function dependencyState(
  node: PlanNode,
  statusByResource: ReadonlyMap<string, RequestStatus>,
): DependencyState {
  const missing: string[] = [];
  const blocked: string[] = [];
  const pending: string[] = [];
  for (const dep of [...new Set(node.dependsOn)].sort()) {
    const status = statusByResource.get(dep);
    if (status === undefined) missing.push(dep);
    else if (status === "DENIED" || status === "REJECTED") blocked.push(dep);
    else if (status !== "PROVISIONED") pending.push(dep);
  }
  if (missing.length > 0) return { kind: "MISSING", missing };
  if (blocked.length > 0) return { kind: "UNSATISFIABLE", blocked };
  if (pending.length > 0) return { kind: "WAITING", pending };
  return { kind: "SATISFIED" };
}

export interface Blocker {
  code: string;
  blockerClass: BlockerClass;
  /**
   * When the periodic reconciler should look again: RECONCILE (external wait), FULFILLMENT
   * (M7D ServiceNow fulfillment wait), RETRY (transient failure) or NONE (event-driven only).
   */
  schedule: "RECONCILE" | "FULFILLMENT" | "RETRY" | "NONE";
}

export const BLOCKERS = {
  AWAITING_APPROVAL: { code: "AWAITING_APPROVAL", blockerClass: "WAITING", schedule: "NONE" },
  DEPENDENCIES_NOT_READY: {
    code: "DEPENDENCIES_NOT_READY",
    blockerClass: "WAITING",
    schedule: "NONE",
  },
  MISSING_AUTHORIZED_DEPENDENCY: {
    code: "MISSING_AUTHORIZED_DEPENDENCY",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  DEPENDENCY_NOT_AUTHORIZED: {
    code: "DEPENDENCY_NOT_AUTHORIZED",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  UNSUPPORTED_PROVISIONING_PROVIDER: {
    code: "UNSUPPORTED_PROVISIONING_PROVIDER",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  PROVIDER_NOT_CONFIGURED: {
    code: "PROVIDER_NOT_CONFIGURED",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  RESOURCE_NOT_IN_CATALOG: {
    code: "RESOURCE_NOT_IN_CATALOG",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  MANUAL_ACTION_REQUIRED: {
    code: "MANUAL_ACTION_REQUIRED",
    blockerClass: "MANUAL",
    schedule: "NONE",
  },
  PROVISIONING_FAILED: {
    code: "PROVISIONING_FAILED",
    blockerClass: "DETERMINISTIC_FAILURE",
    schedule: "NONE",
  },
  GITHUB_INVITATION_PENDING: {
    code: "GITHUB_INVITATION_PENDING",
    blockerClass: "WAITING",
    schedule: "RECONCILE",
  },
  SERVICENOW_FULFILLMENT_PENDING: {
    code: "SERVICENOW_FULFILLMENT_PENDING",
    blockerClass: "WAITING",
    schedule: "FULFILLMENT",
  },
  SERVICENOW_FULFILLMENT_IN_PROGRESS: {
    code: "SERVICENOW_FULFILLMENT_IN_PROGRESS",
    blockerClass: "WAITING",
    schedule: "FULFILLMENT",
  },
  GITHUB_IDENTITY_CLAIM_REQUIRED: {
    code: "GITHUB_IDENTITY_CLAIM_REQUIRED",
    blockerClass: "WAITING",
    schedule: "NONE",
  },
  TRANSIENT_PROVIDER_FAILURE: {
    code: "TRANSIENT_PROVIDER_FAILURE",
    blockerClass: "RETRYABLE",
    schedule: "RETRY",
  },
} as const satisfies Record<string, Blocker>;

/**
 * Classifies a provider service error (M7A/M7B error codes) into an orchestration blocker.
 * Waiting on a human (HR claim) is event-driven; transient provider trouble is retried on a
 * schedule; everything deterministic is surfaced without polling (a wake event retries it).
 */
export function classifyDispatchError(err: {
  code: string;
  retryable: boolean;
  reason?: string | undefined;
}): Blocker {
  if (err.code === "GITHUB_IDENTITY_CLAIM_REQUIRED") return BLOCKERS.GITHUB_IDENTITY_CLAIM_REQUIRED;
  if (err.code === "DEPENDENCIES_NOT_READY") return BLOCKERS.DEPENDENCIES_NOT_READY;
  if (err.code === "PROVISIONING_FAILED") return BLOCKERS.PROVISIONING_FAILED;
  if (err.retryable) return BLOCKERS.TRANSIENT_PROVIDER_FAILURE;
  return { code: err.code, blockerClass: "DETERMINISTIC_FAILURE", schedule: "NONE" };
}

/** Blocker for a request the coordinator won't dispatch because of its status alone. */
export function statusBlocker(status: RequestStatus): Blocker | null {
  switch (status) {
    case "AWAITING_APPROVAL":
      return BLOCKERS.AWAITING_APPROVAL;
    case "MANUAL_ACTION_REQUIRED":
      return BLOCKERS.MANUAL_ACTION_REQUIRED;
    case "PROVISIONING_FAILED":
      return BLOCKERS.PROVISIONING_FAILED;
    default:
      return null;
  }
}

/**
 * The workflow may leave PROVISIONING only when the plan has no unresolved work: every request
 * PROVISIONED, DENIED or REJECTED (vacuously true for zero requests) and no plan-level issue.
 */
export function completionState(
  statuses: readonly RequestStatus[],
  planIssues: readonly string[] = [],
): { complete: boolean; unresolved: number } {
  const unresolved = statuses.filter((s) => !isSettled(s)).length;
  return { complete: unresolved === 0 && planIssues.length === 0, unresolved };
}
