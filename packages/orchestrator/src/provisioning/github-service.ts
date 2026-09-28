import type { CatalogRegistry } from "@aoo/catalog";
import {
  accessRequests,
  auditEvents,
  externalIdentities,
  externalIdentityClaims,
  externalOperations,
  type AccessRequest,
  type Database,
  type Employee,
} from "@aoo/db";
import { GitHubError, type GitHubTarget } from "@aoo/github";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { noopLogger, type EventLogger } from "../events/types.js";
import { ExternalOperationError } from "../external-operations/errors.js";
import { GITHUB_CLAIM_SOURCE } from "./github-identity.js";
import type { ExecutionSuccess, ExternalOperationService } from "../external-operations/service.js";
import {
  EligibilityError,
  loadAuthorizedRequest,
  missingDependencies,
  resolveProviderResource,
  type AuthorizedRequest,
  type EligibilityCode,
} from "./eligibility.js";
import {
  GITHUB_ENSURE_ORG_MEMBERSHIP,
  GITHUB_ENSURE_TEAM_MEMBERSHIP,
  githubOrgMembershipKeys,
  githubTeamMembershipKeys,
  type GitHubGateway,
} from "./github-handlers.js";

export const GITHUB_PROVISIONING_ACTOR = "github-provisioning";

export type GitHubProvisioningErrorCode =
  | EligibilityCode
  | "INVALID_INPUT"
  | "GITHUB_TARGET_NOT_CONFIGURED"
  | "DEPENDENCIES_NOT_READY"
  /**
   * Non-terminal prerequisite: HR hasn't recorded the employee's GitHub username (never inferred).
   * The request stays READY_FOR_PROVISIONING; re-invoke after HR records it.
   */
  | "GITHUB_IDENTITY_CLAIM_REQUIRED"
  | "GITHUB_IDENTITY_NOT_FOUND"
  | "GITHUB_IDENTITY_CONFLICT"
  | "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE"
  | "GITHUB_ORG_NOT_FOUND"
  | "GITHUB_TEAM_NOT_FOUND"
  | "GITHUB_TEAM_MISMATCH"
  | "GITHUB_ORG_MEMBERSHIP_NOT_ACTIVE"
  /** A deterministic GitHub failure before any write (e.g. authentication). */
  | "GITHUB_REQUEST_FAILED"
  /** Terminal: the resource is PROVISIONING_FAILED. */
  | "PROVISIONING_FAILED"
  /** Transient: another owner is working, or GitHub was unavailable. Re-invoke later. */
  | "RETRY_LATER";

export class GitHubProvisioningError extends Error {
  readonly code: GitHubProvisioningErrorCode;
  readonly retryable: boolean;
  readonly accessRequestId: string | undefined;
  readonly reason: string | undefined;

  constructor(
    code: GitHubProvisioningErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      accessRequestId?: string | undefined;
      reason?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.accessRequestId = options.accessRequestId;
    this.reason = options.reason;
  }
}

export interface GitHubProvisioningResult {
  readonly accessRequestId: string;
  readonly accessDecisionId: string;
  readonly workflowId: string;
  readonly resourceId: string;
  /** PENDING_ACCEPTANCE: GitHub holds an invitation the user has not accepted (still PROVISIONING). */
  readonly status: "PROVISIONED" | "PENDING_ACCEPTANCE";
  readonly outcome: "PROVISIONED" | "ALREADY_PRESENT" | "GITHUB_INVITATION_PENDING" | "REPLAYED";
  readonly replayed: boolean;
  readonly githubUserId: number;
  readonly githubLogin: string;
  readonly organization: string;
  readonly teamId: number | null;
  readonly teamSlug: string | null;
  /** LINKED: verified link reused; RESOLVED: claim resolved and linked now; LOGIN_UPDATED: same id, renamed login. */
  readonly identity: "LINKED" | "RESOLVED" | "LOGIN_UPDATED" | "REPLAYED";
  readonly operationId: string;
  readonly provisionedAt: Date | null;
}

export interface GitHubProvisioningService {
  /**
   * Provisions exactly one authorized GITHUB access request (org or team membership). Additive and
   * member-role only. Idempotent and safe to call concurrently; a pending invitation is never
   * re-sent. Never provisions other resources or dependencies.
   */
  provisionGitHubAccess(input: { accessRequestId: string }): Promise<GitHubProvisioningResult>;
}

export interface GitHubProvisioningServiceOptions {
  catalogs: CatalogRegistry;
  /** The durable executor, configured with createGitHubHandlers. */
  externalOperations: ExternalOperationService;
  /** Read access for identity resolution, target checks and pending-invitation re-checks. */
  github: Pick<
    GitHubGateway,
    "getUserByLogin" | "getUserById" | "getTeam" | "getOrgMembership" | "getTeamMembership"
  >;
  targets: ReadonlyMap<string, GitHubTarget>;
  ownerId?: string;
  leaseMs?: number;
  busyWaitMs?: number;
  logger?: EventLogger;
}

const clock = sql`clock_timestamp()`;
const InputSchema = z.strictObject({ accessRequestId: z.uuid() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGitHubProvisioningService(
  db: Database,
  options: GitHubProvisioningServiceOptions,
): GitHubProvisioningService {
  const { catalogs, externalOperations: extOps, github: gh, targets } = options;
  const ownerId = options.ownerId ?? `github-provisioner-${process.pid}`;
  const leaseMs = options.leaseMs ?? 60_000;
  const busyWaitMs = options.busyWaitMs ?? 5_000;
  const logger = options.logger ?? noopLogger;

  const audit = (
    request: AccessRequest,
    eventType: string,
    key: string,
    payload: Record<string, unknown>,
  ) => ({
    workflowId: request.workflowId,
    eventType,
    actor: GITHUB_PROVISIONING_ACTOR,
    correlationId: `provisioning:${request.id}`,
    idempotencyKey: key,
    payload: {
      accessRequestId: request.id,
      resourceId: request.resourceId,
      provider: "GITHUB",
      ...payload,
    },
  });

  /** Reads before any write: GitHub read failures become RETRY_LATER or GITHUB_REQUEST_FAILED. */
  async function read<T>(accessRequestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitHubError) {
        throw err.retryable
          ? new GitHubProvisioningError("RETRY_LATER", err.message, {
              retryable: true,
              accessRequestId,
            })
          : new GitHubProvisioningError("GITHUB_REQUEST_FAILED", err.message, {
              accessRequestId,
              reason: err.code,
            });
      }
      throw err;
    }
  }

  async function executeOrWait(operationId: string): Promise<ExecutionSuccess> {
    const started = Date.now();
    for (;;) {
      try {
        return await extOps.execute(operationId, { ownerId, leaseMs });
      } catch (err) {
        if (
          err instanceof ExternalOperationError &&
          err.code === "BUSY" &&
          Date.now() - started < busyWaitMs
        ) {
          await wait(100);
          continue;
        }
        throw err;
      }
    }
  }

  async function markFailed(
    request: AccessRequest,
    reason: string,
    context: Record<string, unknown>,
  ) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(accessRequests)
        .set({
          status: "PROVISIONING_FAILED",
          provisioningErrorCode: reason,
          providerState: null,
          version: sql`${accessRequests.version} + 1`,
          updatedAt: clock,
        })
        .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
        .returning();
      if (row) {
        await tx
          .insert(auditEvents)
          .values(
            audit(
              request,
              "resource.provisioning_failed",
              `access-request:${request.id}:provisioning-failed`,
              { reason, ...context },
            ),
          )
          .onConflictDoNothing();
      }
    });
  }

  async function onOperationError(
    err: unknown,
    request: AccessRequest,
    providerOperation: string,
  ): Promise<never> {
    if (err instanceof ExternalOperationError && err.retryable) {
      throw new GitHubProvisioningError("RETRY_LATER", `${providerOperation}: ${err.message}`, {
        retryable: true,
        accessRequestId: request.id,
      });
    }
    if (err instanceof ExternalOperationError) {
      let reason: string = err.code;
      if (err.operationId) {
        const [op] = await db
          .select({ detail: externalOperations.lastErrorDetail })
          .from(externalOperations)
          .where(eq(externalOperations.id, err.operationId));
        const code = (op?.detail as { code?: unknown } | null)?.code;
        if (typeof code === "string") reason = code;
      }
      await markFailed(request, reason, {
        providerOperation,
        ...(err.operationId && { externalOperationId: err.operationId }),
      });
      throw new GitHubProvisioningError(
        "PROVISIONING_FAILED",
        `${providerOperation} stopped: ${reason}`,
        { accessRequestId: request.id, reason },
      );
    }
    throw err;
  }

  /**
   * The employee's GitHub identity: the verified link (by immutable id), or the HR-recorded
   * claim resolved exactly and linked now. Never inferred, never searched, never overwritten.
   */
  async function resolveIdentity(employee: Employee, request: AccessRequest) {
    const id = request.id;
    const fail = (code: GitHubProvisioningErrorCode, msg: string) =>
      new GitHubProvisioningError(code, msg, { accessRequestId: id });
    const [link] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.employeeId, employee.id),
          eq(externalIdentities.provider, "github"),
        ),
      );
    const [claim] = await db
      .select()
      .from(externalIdentityClaims)
      .where(
        and(
          eq(externalIdentityClaims.employeeId, employee.id),
          eq(externalIdentityClaims.provider, "github"),
          eq(externalIdentityClaims.source, GITHUB_CLAIM_SOURCE),
        ),
      );

    if (link) {
      const user = await read(id, () => gh.getUserById(Number(link.providerSubjectId)));
      if (!user)
        throw fail("GITHUB_IDENTITY_NOT_FOUND", "the linked GitHub account no longer exists");
      if (user.type !== "User")
        throw fail("GITHUB_IDENTITY_CONFLICT", "the linked GitHub account is not a user");
      const known = [link.providerLogin.toLowerCase(), user.login.toLowerCase()];
      if (claim && !known.includes(claim.claimedLogin.toLowerCase())) {
        // A newer claim names another login: it must be the same immutable account.
        const claimed = await read(id, () => gh.getUserByLogin(claim.claimedLogin));
        if (!claimed || claimed.id !== user.id) {
          throw fail(
            "GITHUB_IDENTITY_CONFLICT",
            "the current GitHub claim points to another account than the verified link",
          );
        }
      }
      if (user.login !== link.providerLogin) {
        // Login drift: same immutable id, renamed login. The id stays authoritative.
        await db.transaction(async (tx) => {
          await tx
            .update(externalIdentities)
            .set({ providerLogin: user.login, verifiedAt: clock as unknown as Date })
            .where(eq(externalIdentities.id, link.id));
          await tx
            .insert(auditEvents)
            .values(
              audit(
                request,
                "github.identity_login_changed",
                `external-identity:${link.id}:login:${user.login.toLowerCase()}`,
                {
                  employeeId: employee.id,
                  githubUserId: user.id,
                  externalIdentityId: link.id,
                },
              ),
            )
            .onConflictDoNothing();
        });
        return { userId: user.id, login: user.login, identity: "LOGIN_UPDATED" as const };
      }
      return { userId: user.id, login: user.login, identity: "LINKED" as const };
    }

    if (!claim) {
      throw new GitHubProvisioningError(
        "GITHUB_IDENTITY_CLAIM_REQUIRED",
        "HR has not recorded the employee's GitHub username yet",
        { accessRequestId: id, retryable: true },
      );
    }
    const user = await read(id, () => gh.getUserByLogin(claim.claimedLogin));
    if (!user) throw fail("GITHUB_IDENTITY_NOT_FOUND", "the claimed GitHub login does not exist");
    if (user.login.toLowerCase() !== claim.claimedLogin.toLowerCase() || user.type !== "User") {
      throw fail(
        "GITHUB_IDENTITY_CONFLICT",
        "GitHub returned a different account than the claimed login",
      );
    }
    const linked = await db.transaction(async (tx) => {
      // Same lock as claim submission: the claim can't change between this check and the link.
      await tx.execute(sql`SELECT id FROM employees WHERE id = ${employee.id} FOR UPDATE`);
      const [current] = await tx
        .select()
        .from(externalIdentityClaims)
        .where(
          and(
            eq(externalIdentityClaims.employeeId, employee.id),
            eq(externalIdentityClaims.provider, "github"),
            eq(externalIdentityClaims.source, GITHUB_CLAIM_SOURCE),
          ),
        );
      if (current?.claimedLogin.toLowerCase() !== user.login.toLowerCase()) {
        return "CLAIM_CHANGED" as const;
      }
      await tx
        .insert(externalIdentities)
        .values({
          employeeId: employee.id,
          provider: "github",
          providerSubjectId: String(user.id),
          providerLogin: user.login,
          verifiedAt: clock as unknown as Date,
        })
        .onConflictDoNothing();
      const [mine] = await tx
        .select()
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.employeeId, employee.id),
            eq(externalIdentities.provider, "github"),
          ),
        );
      if (!mine) return "OWNED_BY_OTHER" as const;
      if (mine.providerSubjectId !== String(user.id)) return "CONFLICT" as const;
      await tx
        .insert(auditEvents)
        .values(
          audit(request, "github.identity_resolved", `external-identity:${mine.id}:linked`, {
            employeeId: employee.id,
            githubUserId: user.id,
            externalIdentityId: mine.id,
          }),
        )
        .onConflictDoNothing();
      return "LINKED" as const;
    });
    if (linked === "CLAIM_CHANGED") {
      throw new GitHubProvisioningError(
        "RETRY_LATER",
        "the GitHub claim changed during resolution",
        { accessRequestId: id, retryable: true },
      );
    }
    if (linked === "OWNED_BY_OTHER") {
      throw fail(
        "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE",
        "the GitHub account is linked to another employee",
      );
    }
    if (linked === "CONFLICT")
      throw fail("GITHUB_IDENTITY_CONFLICT", "the employee is linked to another GitHub account");
    return { userId: user.id, login: user.login, identity: "RESOLVED" as const };
  }

  function replayResult(request: AccessRequest, decisionId: string): GitHubProvisioningResult {
    const ev = (request.providerEvidence ?? {}) as {
      githubLogin?: string;
      organization?: string;
      teamId?: number;
      teamSlug?: string;
    };
    return Object.freeze({
      accessRequestId: request.id,
      accessDecisionId: decisionId,
      workflowId: request.workflowId,
      resourceId: request.resourceId,
      status: "PROVISIONED" as const,
      outcome: "REPLAYED" as const,
      replayed: true,
      githubUserId: Number(request.providerSubjectId),
      githubLogin: ev.githubLogin ?? "",
      organization: ev.organization ?? "",
      teamId: ev.teamId ?? null,
      teamSlug: ev.teamSlug ?? null,
      identity: "REPLAYED" as const,
      operationId: request.provisioningOperationId!,
      provisionedAt: request.provisionedAt,
    });
  }

  return {
    async provisionGitHubAccess(rawInput) {
      const parsed = InputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new GitHubProvisioningError(
          "INVALID_INPUT",
          "provisionGitHubAccess needs an access request uuid",
        );
      const { accessRequestId } = parsed.data;
      const started = performance.now();
      const eligible = <T>(fn: () => T): T => {
        try {
          return fn();
        } catch (err) {
          if (err instanceof EligibilityError)
            throw new GitHubProvisioningError(err.code, err.message, { accessRequestId });
          throw err;
        }
      };

      // 1. Authorization chain, exact resource, target and dependencies (fail-closed, no writes).
      let authorized: AuthorizedRequest;
      try {
        authorized = await loadAuthorizedRequest(db, accessRequestId);
      } catch (err) {
        if (err instanceof EligibilityError)
          throw new GitHubProvisioningError(err.code, err.message, { accessRequestId });
        throw err;
      }
      const { request, decision, employee } = authorized;
      if (request.status === "PROVISIONING_FAILED") {
        throw new GitHubProvisioningError(
          "PROVISIONING_FAILED",
          `provisioning failed earlier: ${request.provisioningErrorCode}`,
          {
            accessRequestId,
            reason: request.provisioningErrorCode ?? undefined,
          },
        );
      }
      if (request.status === "PROVISIONED") return replayResult(request, decision.id);
      const resource = eligible(() =>
        resolveProviderResource(catalogs, decision, request, "GITHUB"),
      );
      const target = targets.get(resource.resourceId);
      if (!target) {
        throw new GitHubProvisioningError(
          "GITHUB_TARGET_NOT_CONFIGURED",
          `no GitHub target is configured for ${resource.resourceId}`,
          { accessRequestId },
        );
      }
      const missing = await missingDependencies(db, request, resource);
      if (missing.length > 0) {
        throw new GitHubProvisioningError(
          "DEPENDENCIES_NOT_READY",
          `dependencies not provisioned: ${missing.join(", ")}`,
          { accessRequestId },
        );
      }

      // 2. Exact GitHub identity (reads only; fixable identity problems leave the request untouched).
      const identity = await resolveIdentity(employee, request);

      // 3. Exact team target and active org membership before any team write (reads only).
      let team: { id: number; slug: string; name: string } | null = null;
      if (target.kind === "team") {
        const found = await read(accessRequestId, () => gh.getTeam(target.org, target.teamSlug));
        if (!found)
          throw new GitHubProvisioningError(
            "GITHUB_TEAM_NOT_FOUND",
            "the configured team does not exist",
            { accessRequestId },
          );
        if (found.slug !== target.teamSlug || found.name !== target.teamName) {
          throw new GitHubProvisioningError(
            "GITHUB_TEAM_MISMATCH",
            "the configured team slug/name do not match GitHub",
            { accessRequestId },
          );
        }
        team = found;
        const org = await read(accessRequestId, () =>
          gh.getOrgMembership(target.org, identity.login),
        );
        if (!org || org.state !== "active" || org.user.id !== identity.userId) {
          throw new GitHubProvisioningError(
            "GITHUB_ORG_MEMBERSHIP_NOT_ACTIVE",
            "the user is not an active organization member",
            { accessRequestId },
          );
        }
      }

      // 4. Claim provisioning intent (short transaction).
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(accessRequests)
          .set({
            status: "PROVISIONING",
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
        if (claimed) {
          await tx
            .insert(auditEvents)
            .values(
              audit(
                request,
                "resource.provisioning_started",
                `access-request:${request.id}:provisioning-started`,
                { accessDecisionId: decision.id },
              ),
            )
            .onConflictDoNothing();
        }
      });
      const current = { ...request, status: "PROVISIONING" as const };

      // 5. One durable operation per authorized request (read → write once → read back).
      const common = {
        accessRequestId: request.id,
        accessDecisionId: decision.id,
        org: target.org,
        githubUserId: identity.userId,
        login: identity.login,
      };
      const op =
        team && target.kind === "team"
          ? {
              type: GITHUB_ENSURE_TEAM_MEMBERSHIP,
              keys: githubTeamMembershipKeys({ ...common, teamId: team.id }),
              request: {
                ...common,
                teamId: team.id,
                teamSlug: target.teamSlug,
                teamName: target.teamName,
              },
            }
          : {
              type: GITHUB_ENSURE_ORG_MEMBERSHIP,
              keys: githubOrgMembershipKeys(common),
              request: common,
            };
      let applied: ExecutionSuccess;
      let operationId: string;
      try {
        const { operation } = await extOps.requestOperation({
          workflowId: request.workflowId,
          provider: "github",
          operationType: op.type,
          ...op.keys,
          request: op.request,
          actor: GITHUB_PROVISIONING_ACTOR,
          enqueueExecution: false,
        });
        operationId = operation.id;
        applied = await executeOrWait(operation.id);
      } catch (err) {
        return onOperationError(err, current, op.type);
      }

      // 6. Pending acceptance: never re-send; re-read GitHub (reads only) on every later call.
      let state = applied.externalReference as "active" | "pending";
      if (state === "pending" && applied.via === "already_succeeded") {
        const now =
          team && target.kind === "team"
            ? await read(accessRequestId, () =>
                gh.getTeamMembership(target.org, target.teamSlug, identity.login),
              )
            : await read(accessRequestId, () => gh.getOrgMembership(target.org, identity.login));
        if (now?.state === "active") state = "active";
      }
      const evidence = {
        githubLogin: identity.login,
        organization: target.org,
        ...(team && { teamId: team.id, teamSlug: team.slug }),
        membershipState: state,
      };
      const base = {
        accessRequestId: request.id,
        accessDecisionId: decision.id,
        workflowId: request.workflowId,
        resourceId: request.resourceId,
        githubUserId: identity.userId,
        githubLogin: identity.login,
        organization: target.org,
        teamId: team?.id ?? null,
        teamSlug: team?.slug ?? null,
        identity: identity.identity,
        operationId,
      };
      const payload = {
        accessDecisionId: decision.id,
        employeeId: employee.id,
        externalOperationId: operationId,
        githubUserId: identity.userId,
        organization: target.org,
        ...(team && { teamId: team.id, teamSlug: team.slug }),
      };
      const kind = team ? "team" : "org";

      if (state === "pending") {
        await db.transaction(async (tx) => {
          const [row] = await tx
            .update(accessRequests)
            .set({
              providerState: "INVITATION_PENDING",
              providerEvidence: evidence,
              updatedAt: clock,
            })
            .where(
              and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")),
            )
            .returning();
          if (row) {
            await tx
              .insert(auditEvents)
              .values(
                audit(
                  request,
                  `github.${kind}_invitation_created`,
                  `access-request:${request.id}:github-invitation`,
                  payload,
                ),
              )
              .onConflictDoNothing();
          }
        });
        logger.info(
          {
            provider: "GITHUB",
            ...base,
            outcome: "GITHUB_INVITATION_PENDING",
            reconciliation: applied.via,
          },
          "github invitation pending",
        );
        return Object.freeze({
          ...base,
          status: "PENDING_ACCEPTANCE" as const,
          outcome: "GITHUB_INVITATION_PENDING" as const,
          replayed: false,
          provisionedAt: null,
        });
      }

      // 7. Active: persist PROVISIONED with evidence (short transaction, guarded by status).
      const alreadyPresent = applied.via === "reconciled";
      const completed = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(accessRequests)
          .set({
            status: "PROVISIONED",
            provisioningOperationId: operationId,
            providerSubjectId: String(identity.userId),
            providerTargetId: team ? String(team.id) : target.org,
            providerState: null,
            providerEvidence: evidence,
            provisionedAt: clock,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: clock,
          } as never)
          .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
          .returning();
        if (!row) return null;
        await tx
          .insert(auditEvents)
          .values([
            audit(
              request,
              `github.${kind}_membership_${alreadyPresent ? "already_present" : "provisioned"}`,
              `access-request:${request.id}:github-membership`,
              payload,
            ),
            audit(
              request,
              "resource.provisioned",
              `access-request:${request.id}:provisioned`,
              payload,
            ),
          ])
          .onConflictDoNothing();
        return row;
      });
      const final =
        completed ??
        (await db.select().from(accessRequests).where(eq(accessRequests.id, request.id)))[0]!;
      if (final.status !== "PROVISIONED") {
        throw new GitHubProvisioningError("RETRY_LATER", `access request is ${final.status}`, {
          retryable: true,
          accessRequestId,
        });
      }
      logger.info(
        {
          provider: "GITHUB",
          ...base,
          employeeId: employee.id,
          providerOperation: op.type,
          outcome: completed
            ? alreadyPresent
              ? "ALREADY_PRESENT"
              : "PROVISIONED"
            : "ALREADY_PROVISIONED",
          reconciliation: applied.via,
          latencyMs: Math.round(performance.now() - started),
        },
        "github access provisioned",
      );
      if (!completed) return replayResult(final, decision.id);
      return Object.freeze({
        ...base,
        status: "PROVISIONED" as const,
        outcome: alreadyPresent ? ("ALREADY_PRESENT" as const) : ("PROVISIONED" as const),
        replayed: false,
        provisionedAt: final.provisionedAt,
      });
    },
  };
}
