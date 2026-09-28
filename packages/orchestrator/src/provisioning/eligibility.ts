import { CatalogError, type CatalogRegistry, type CatalogResource } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  approvals,
  employees,
  type AccessDecision,
  type AccessRequest,
  type Database,
  type Employee,
} from "@aoo/db";
import { and, eq } from "drizzle-orm";

/** Shared, provider-independent provisioning eligibility codes (M7A/M7B). */
export type EligibilityCode =
  | "ACCESS_REQUEST_NOT_FOUND"
  /** DENIED, REJECTED, AWAITING_APPROVAL or otherwise not authorized for provisioning. */
  | "NOT_ELIGIBLE"
  /** Access request, decision and approval don't form a valid authorization chain. */
  | "AUTHORIZATION_CHAIN_INVALID"
  | "CATALOG_UNAVAILABLE"
  | "RESOURCE_NOT_IN_CATALOG"
  | "PROVIDER_MISMATCH";

export class EligibilityError extends Error {
  constructor(
    readonly code: EligibilityCode,
    message: string,
  ) {
    super(message);
    this.name = "EligibilityError";
  }
}

export interface AuthorizedRequest {
  request: AccessRequest;
  decision: AccessDecision;
  employee: Employee;
}

const PROVISIONABLE = [
  "READY_FOR_PROVISIONING",
  "PROVISIONING",
  "PROVISIONED",
  "PROVISIONING_FAILED",
];

/**
 * Loads an access request with its decision and employee and validates the authorization chain,
 * fail-closed. The workflow state is never consulted: the request and decision are the authority.
 * PROVISIONED and PROVISIONING_FAILED requests pass (callers replay or report them).
 */
export async function loadAuthorizedRequest(
  db: Database,
  accessRequestId: string,
): Promise<AuthorizedRequest> {
  const [found] = await db
    .select({ request: accessRequests, decision: accessDecisions, employee: employees })
    .from(accessRequests)
    .innerJoin(accessDecisions, eq(accessDecisions.id, accessRequests.accessDecisionId))
    .innerJoin(employees, eq(employees.id, accessRequests.employeeId))
    .where(eq(accessRequests.id, accessRequestId));
  if (!found) {
    throw new EligibilityError(
      "ACCESS_REQUEST_NOT_FOUND",
      `access request ${accessRequestId} not found`,
    );
  }
  const { request, decision } = found;
  const chain = (msg: string) => new EligibilityError("AUTHORIZATION_CHAIN_INVALID", msg);
  if (!PROVISIONABLE.includes(request.status)) {
    throw new EligibilityError(
      "NOT_ELIGIBLE",
      `access request is ${request.status}; only authorized resources are provisioned`,
    );
  }
  if (
    request.workflowId !== decision.workflowId ||
    request.employeeId !== decision.employeeId ||
    request.agentRunId !== decision.agentRunId ||
    request.resourceId !== decision.resourceId
  ) {
    throw chain("access request and decision disagree on workflow, employee, run or resource");
  }
  if (decision.decision === "ALLOW") {
    if (request.authorizedVia !== "POLICY")
      throw chain("an ALLOW decision must be authorized by policy");
  } else if (decision.decision === "REQUIRES_APPROVAL") {
    if (
      request.authorizedVia !== "APPROVAL" ||
      !request.approvalId ||
      !request.externalOperationId
    ) {
      throw chain("an approval-required decision needs a verified approval");
    }
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, request.approvalId));
    if (
      !approval ||
      approval.status !== "APPROVED" ||
      approval.externalOperationId !== request.externalOperationId ||
      approval.workflowId !== request.workflowId
    ) {
      throw chain("the approval is not a verified APPROVED approval for this request");
    }
  } else {
    throw chain(`decision ${decision.decision} never authorizes provisioning`);
  }
  return found;
}

/** The exact catalog resource of the decision, which must belong to `provider`. */
export function resolveProviderResource(
  catalogs: CatalogRegistry,
  decision: AccessDecision,
  request: AccessRequest,
  provider: CatalogResource["provider"],
): CatalogResource {
  let resource: CatalogResource;
  try {
    const catalog = catalogs.resolve({
      catalogVersion: decision.catalogVersion,
      catalogHash: decision.catalogHash,
    });
    if (!catalog.hasResource(request.resourceId)) {
      throw new EligibilityError(
        "RESOURCE_NOT_IN_CATALOG",
        "resource is not in the decision's catalog",
      );
    }
    resource = catalog.getResource(request.resourceId);
  } catch (err) {
    if (err instanceof CatalogError) throw new EligibilityError("CATALOG_UNAVAILABLE", err.message);
    throw err;
  }
  if (resource.provider !== provider) {
    throw new EligibilityError(
      "PROVIDER_MISMATCH",
      `resource provider is ${resource.provider}, not ${provider}`,
    );
  }
  return resource;
}

/** Declared catalog dependencies not yet PROVISIONED in the same workflow (no graph execution). */
export async function missingDependencies(
  db: Database,
  request: AccessRequest,
  resource: CatalogResource,
): Promise<string[]> {
  const missing: string[] = [];
  for (const dep of resource.dependsOn) {
    const [ready] = await db
      .select({ id: accessRequests.id })
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.workflowId, request.workflowId),
          eq(accessRequests.resourceId, dep),
          eq(accessRequests.status, "PROVISIONED"),
        ),
      );
    if (!ready) missing.push(dep);
  }
  return missing;
}
