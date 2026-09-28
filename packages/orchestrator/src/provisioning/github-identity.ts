import { CatalogError, type CatalogRegistry } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  auditEvents,
  employees,
  externalIdentities,
  externalIdentityClaims,
  onboardingWorkflows,
  type AccessRequest,
  type Database,
} from "@aoo/db";
import {
  GitHubIdentityClaimRequestSchema,
  TERMINAL_WORKFLOW_STATES,
  type GitHubIdentityClaimResponse,
  type GitHubIdentityStatus,
} from "@aoo/shared";
import { and, asc, eq, sql } from "drizzle-orm";

/** Claims recorded by HR/onboarding staff. Only these are honored (legacy sources are ignored). */
export const GITHUB_CLAIM_SOURCE = "HR_INPUT";
/** Self-declared HR/onboarding operator id, recorded as the audit actor `hr:<id>`. */
export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export type GitHubIdentityErrorCode =
  | "INVALID_GITHUB_LOGIN"
  | "INVALID_OPERATOR_ID"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_NOT_ACTIVE"
  /** A GitHub account is already linked by immutable id; switching needs admin remediation. */
  | "GITHUB_IDENTITY_ALREADY_LINKED";

export class GitHubIdentityError extends Error {
  constructor(
    readonly code: GitHubIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubIdentityError";
  }
}

export interface GitHubIdentityService {
  /** HR view: the employee's work email, GitHub identity state and resource progress. */
  getStatus(workflowId: string): Promise<GitHubIdentityStatus>;
  /**
   * Records the GitHub username HR/onboarding staff received from the employee (source
   * HR_INPUT, actor `hr:<operatorId>`). Identity data only: no policy decision,
   * no GitHub call, no ticket, no provisioning. Idempotent for the same login (case-insensitive).
   * Before a GitHub account is linked the claim may be corrected (audited); afterwards a
   * different login is refused with GITHUB_IDENTITY_ALREADY_LINKED.
   */
  submitClaim(input: {
    workflowId: string;
    githubLogin: unknown;
    operatorId: string;
  }): Promise<GitHubIdentityClaimResponse>;
}

/** HR-recorded GitHub identity claims (M7B). `provisionGitHubAccess` resolves them later. */
export function createGitHubIdentityService(
  db: Database,
  options: { catalogs: CatalogRegistry },
): GitHubIdentityService {
  async function loadWorkflow(workflowId: string) {
    const [row] = await db
      .select({ workflow: onboardingWorkflows, employee: employees })
      .from(onboardingWorkflows)
      .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
      .where(eq(onboardingWorkflows.id, workflowId));
    if (!row) throw new GitHubIdentityError("WORKFLOW_NOT_FOUND", "workflow not found");
    return row;
  }

  /** The workflow's GitHub access requests (latest per resource), with catalog display names. */
  async function githubRequests(workflowId: string) {
    const rows = await db
      .select({ request: accessRequests, decision: accessDecisions })
      .from(accessRequests)
      .innerJoin(accessDecisions, eq(accessDecisions.id, accessRequests.accessDecisionId))
      .where(eq(accessRequests.workflowId, workflowId))
      .orderBy(asc(accessRequests.createdAt));
    const latest = new Map<string, { request: AccessRequest; displayName: string }>();
    for (const { request, decision } of rows) {
      let resource;
      try {
        const catalog = options.catalogs.resolve({
          catalogVersion: decision.catalogVersion,
          catalogHash: decision.catalogHash,
        });
        if (!catalog.hasResource(request.resourceId)) continue;
        resource = catalog.getResource(request.resourceId);
      } catch (err) {
        if (err instanceof CatalogError) continue;
        throw err;
      }
      if (resource.provider !== "GITHUB") continue;
      latest.set(request.resourceId, { request, displayName: resource.displayName });
    }
    return [...latest.values()].sort((a, b) =>
      a.request.resourceId.localeCompare(b.request.resourceId),
    );
  }

  async function identityOf(employeeId: string) {
    const [claim] = await db
      .select()
      .from(externalIdentityClaims)
      .where(
        and(
          eq(externalIdentityClaims.employeeId, employeeId),
          eq(externalIdentityClaims.provider, "github"),
          eq(externalIdentityClaims.source, GITHUB_CLAIM_SOURCE),
        ),
      );
    const [link] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.employeeId, employeeId),
          eq(externalIdentities.provider, "github"),
        ),
      );
    return { claim, link };
  }

  async function getStatus(workflowId: string): Promise<GitHubIdentityStatus> {
    const { employee } = await loadWorkflow(workflowId);
    const { claim, link } = await identityOf(employee.id);
    const requests = await githubRequests(workflowId);
    const resources = requests
      .filter(({ request }) => request.status !== "DENIED" && request.status !== "REJECTED")
      .map(({ request, displayName }) => ({
        resourceId: request.resourceId,
        displayName,
        progress: progressOf(request, Boolean(claim || link)),
      }));
    return {
      workflowId,
      employee: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        workEmail: employee.email,
      },
      identityRequired: !link && resources.some((r) => r.progress !== "CONNECTED"),
      identity: {
        state: link ? "RESOLVED" : claim ? "SUBMITTED" : "NOT_SUBMITTED",
        claimedLogin: claim?.claimedLogin ?? null,
        resolvedLogin: link?.providerLogin ?? null,
      },
      resources,
    };
  }

  async function submitClaim(input: {
    workflowId: string;
    githubLogin: unknown;
    operatorId: string;
  }): Promise<GitHubIdentityClaimResponse> {
    if (!OPERATOR_ID_PATTERN.test(input.operatorId)) {
      throw new GitHubIdentityError("INVALID_OPERATOR_ID", "operator id is required");
    }
    const parsed = GitHubIdentityClaimRequestSchema.safeParse({ githubLogin: input.githubLogin });
    if (!parsed.success) {
      throw new GitHubIdentityError("INVALID_GITHUB_LOGIN", "not a valid GitHub username");
    }
    const login = parsed.data.githubLogin;
    const { workflow, employee } = await loadWorkflow(input.workflowId);
    if ((TERMINAL_WORKFLOW_STATES as readonly string[]).includes(workflow.state)) {
      throw new GitHubIdentityError("WORKFLOW_NOT_ACTIVE", "the onboarding workflow has ended");
    }
    const changed = await db.transaction(async (tx) => {
      // Serializes with provisioning's identity linking (same row lock).
      await tx.execute(sql`SELECT id FROM employees WHERE id = ${employee.id} FOR UPDATE`);
      const [link] = await tx
        .select()
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.employeeId, employee.id),
            eq(externalIdentities.provider, "github"),
          ),
        );
      // One row per employee and provider; a legacy (non-HR) row is replaced, never honored.
      const [row] = await tx
        .select()
        .from(externalIdentityClaims)
        .where(
          and(
            eq(externalIdentityClaims.employeeId, employee.id),
            eq(externalIdentityClaims.provider, "github"),
          ),
        );
      const claim = row?.source === GITHUB_CLAIM_SOURCE ? row : undefined;
      const same = (other: string | undefined) => other?.toLowerCase() === login.toLowerCase();
      if (link) {
        // The immutable account is fixed; only the same account's login is accepted (no-op).
        if (same(link.providerLogin) || same(claim?.claimedLogin)) return false;
        throw new GitHubIdentityError(
          "GITHUB_IDENTITY_ALREADY_LINKED",
          "a GitHub account is already linked; changing it needs administrator remediation",
        );
      }
      if (claim && same(claim.claimedLogin)) return false;
      const base = {
        workflowId: workflow.id,
        actor: `hr:${input.operatorId}`,
        workflowVersion: workflow.version,
        correlationId: `github-identity:${employee.id}`,
      };
      const recorded = {
        claimedLogin: login,
        source: GITHUB_CLAIM_SOURCE,
        workflowId: workflow.id,
        recordedBy: input.operatorId,
      };
      if (row) {
        await tx
          .update(externalIdentityClaims)
          .set({ ...recorded, updatedAt: sql`now()` })
          .where(eq(externalIdentityClaims.id, row.id));
        await tx.insert(auditEvents).values({
          ...base,
          eventType: claim ? "github.identity_claim_changed" : "github.identity_claim_recorded",
          payload: {
            employeeId: employee.id,
            claimId: row.id,
            previousLogin: claim?.claimedLogin ?? null,
            ...(claim ? {} : { replacedSource: row.source }),
            claimedLogin: login,
            source: GITHUB_CLAIM_SOURCE,
          },
        });
      } else {
        const [created] = await tx
          .insert(externalIdentityClaims)
          .values({ employeeId: employee.id, provider: "github", ...recorded })
          .returning();
        await tx.insert(auditEvents).values({
          ...base,
          eventType: "github.identity_claim_recorded",
          payload: {
            employeeId: employee.id,
            claimId: created!.id,
            claimedLogin: login,
            source: GITHUB_CLAIM_SOURCE,
          },
        });
      }
      return true;
    });
    return { ...(await getStatus(input.workflowId)), changed };
  }

  return { getStatus, submitClaim };
}

function progressOf(
  request: AccessRequest,
  identityKnown: boolean,
): GitHubIdentityStatus["resources"][number]["progress"] {
  switch (request.status) {
    case "AWAITING_APPROVAL":
      return "AWAITING_APPROVAL";
    case "READY_FOR_PROVISIONING":
      return identityKnown ? "WAITING_TO_START" : "WAITING_FOR_IDENTITY";
    case "PROVISIONING":
      return request.providerState === "INVITATION_PENDING" ? "INVITATION_PENDING" : "IN_PROGRESS";
    case "PROVISIONED":
      return "CONNECTED";
    default:
      return "NEEDS_ATTENTION";
  }
}
