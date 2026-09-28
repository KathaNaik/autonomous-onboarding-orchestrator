import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import {
  CATALOG_RELEASES,
  CatalogRegistry,
  ResourceCatalog,
  loadCatalogRegistry,
} from "@aoo/catalog";
import {
  accessRequests,
  auditEvents,
  createDatabase,
  employees,
  externalIdentities,
  externalIdentityClaims,
  externalOperations,
  type DatabaseHandle,
} from "@aoo/db";
import type { GitHubTarget } from "@aoo/github";
import { loadPolicyRegistry } from "@aoo/policy";
import type { HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  GitHubProvisioningError,
  createAccessAuthorizationService,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubIdentityService,
  createGitHubProvisioningService,
  createHrisIntakeService,
  createRoleAccessRecommendationService,
  createWorkflowService,
  type WorkflowService,
} from "../../src/index.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const catalogs = loadCatalogRegistry();
const policies = loadPolicyRegistry(catalogs);
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
const ORG = "github-org-membership";
const BACKEND = "github-team-backend";
const FRONTEND = "github-team-frontend";

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  workflows = createWorkflowService(handle.db);
});
afterAll(() => handle.close());
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE status = 'PENDING'`);
});

let seq = 0;
function world(opts: { inviteActivates?: boolean } = {}) {
  const gh = new FakeGitHub();
  gh.inviteActivates = opts.inviteActivates ?? true;
  const login = `octo-${Date.now().toString(36)}-${seq++}`;
  const user = gh.seedUser(login);
  const backend = gh.seedTeam("aoo-backend", "AOO Backend");
  const frontend = gh.seedTeam("aoo-frontend", "AOO Frontend");
  return { gh, login, user, backend, frontend };
}
type World = ReturnType<typeof world>;

function targetsFor(w: World, overrides: Partial<Record<string, GitHubTarget | null>> = {}) {
  const base: Record<string, GitHubTarget> = {
    [ORG]: { kind: "org", resourceId: ORG, org: w.gh.org },
    [BACKEND]: {
      kind: "team",
      resourceId: BACKEND,
      org: w.gh.org,
      teamSlug: "aoo-backend",
      teamName: "AOO Backend",
    },
    [FRONTEND]: {
      kind: "team",
      resourceId: FRONTEND,
      org: w.gh.org,
      teamSlug: "aoo-frontend",
      teamName: "AOO Frontend",
    },
  };
  const merged = { ...base, ...overrides };
  return new Map(Object.entries(merged).filter((e): e is [string, GitHubTarget] => e[1] !== null));
}

function provisioner(
  w: World,
  opts: { targets?: Map<string, GitHubTarget>; ownerId?: string; catalogs?: CatalogRegistry } = {},
) {
  const extOps = createExternalOperationService(handle.db, {
    handlers: createGitHubHandlers(w.gh),
    reconcile: { attempts: 2, delayMs: 1 },
  });
  return createGitHubProvisioningService(handle.db, {
    catalogs: opts.catalogs ?? catalogs,
    externalOperations: extOps,
    github: w.gh,
    targets: opts.targets ?? targetsFor(w),
    ownerId: opts.ownerId ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    leaseMs: 30_000,
    busyWaitMs: 5_000,
  });
}

/**
 * Hire (HRIS: no GitHub data) → M6A agent run → M6B authorization → optionally the GitHub username
 * HR recorded, through the same service the HR/operator API uses.
 */
async function authorized(
  resourceIds: string[],
  { githubLogin, ...extra }: Partial<HrisOfferSignedEvent> & { githubLogin?: string } = {},
  facts: Partial<HrisOfferSignedEvent> = {},
) {
  const event = newOfferSignedEvent({
    ...ENGINEER,
    ...facts,
    jobDescription: "Synthetic.",
    ...extra,
  });
  const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  const wf = (await workflows.getWorkflow(workflowId))!.workflow;
  await workflows.transition({
    workflowId,
    to: "ACCESS_PLANNING",
    expectedVersion: wf.version,
    actor: "test",
  });
  const agent = createRoleAccessAgent({
    provider: createScriptedModelProvider([outputOf(...resourceIds)]),
    sleep: async () => {},
  });
  const { agentRunId } = await createRoleAccessRecommendationService(handle.db, {
    agent,
    catalogs,
  }).recommendAccess({ workflowId });
  const fake = new FakeServiceNow();
  const snOps = createExternalOperationService(handle.db, {
    servicenow: fake,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const result = await createAccessAuthorizationService(handle.db, {
    policies,
    catalogs,
    workflows,
    externalOperations: snOps,
  }).authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((r) => [r.resourceId, r.accessRequestId]));
  if (githubLogin)
    await identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin });
  const [employee] = await handle.db
    .select()
    .from(employees)
    .where(eq(employees.hrisEmployeeId, event.employeeId));
  return { ids, workflowId, event, employee: employee!, snOps, fake };
}

const OPERATOR = "hr.test@example.com";
const identities = () => createGitHubIdentityService(handle.db, { catalogs });
const requestRow = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;
const opsOf = (type: string, workflowId: string) =>
  handle.db
    .select()
    .from(externalOperations)
    .where(
      and(
        eq(externalOperations.operationType, type),
        eq(externalOperations.workflowId, workflowId),
      ),
    );
const auditFor = (workflowId: string, prefix: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), like(auditEvents.eventType, `${prefix}%`)));
const linksFor = (employeeId: string) =>
  handle.db
    .select()
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.employeeId, employeeId), eq(externalIdentities.provider, "github")),
    );

async function ghError(p: Promise<unknown>): Promise<GitHubProvisioningError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GitHubProvisioningError) return err;
    throw err;
  }
  throw new Error("expected GitHubProvisioningError");
}

describe("identity (HR-recorded claim → immutable GitHub id)", () => {
  it("persists the HR claim, resolves the exact login and links the immutable id", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids, employee, event, workflowId } = await authorized([ORG], { githubLogin: w.login });
    expect(event).not.toHaveProperty("githubLogin");
    const [claim] = await handle.db
      .select()
      .from(externalIdentityClaims)
      .where(eq(externalIdentityClaims.employeeId, employee.id));
    expect(claim).toMatchObject({
      provider: "github",
      claimedLogin: w.login,
      source: "HR_INPUT",
      recordedBy: OPERATOR,
      sourceEventId: null,
      workflowId,
    });
    const result = await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(result).toMatchObject({
      identity: "RESOLVED",
      githubUserId: w.user.id,
      githubLogin: w.login,
    });
    expect(await linksFor(employee.id)).toMatchObject([
      { providerSubjectId: String(w.user.id), providerLogin: w.login },
    ]);
    expect(w.gh.loginLookups).toEqual([w.login]);
  });

  it("reuses a verified link by id without resolving the login again", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const p = provisioner(w);
    await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    const lookups = w.gh.loginLookups.length;
    expect((await p.provisionGitHubAccess({ accessRequestId: ids[BACKEND]! })).identity).toBe(
      "LINKED",
    );
    expect(w.gh.loginLookups.length).toBe(lookups);
  });

  it("detects login drift (same id, renamed login) and keeps the id authoritative", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids, employee } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const p = provisioner(w);
    await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    w.user.login = `${w.login}-renamed`; // GitHub rename; same immutable id
    const team = await p.provisionGitHubAccess({ accessRequestId: ids[BACKEND]! });
    expect(team).toMatchObject({
      identity: "LOGIN_UPDATED",
      githubUserId: w.user.id,
      githubLogin: `${w.login}-renamed`,
    });
    expect((await linksFor(employee.id))[0]).toMatchObject({
      providerSubjectId: String(w.user.id),
      providerLogin: `${w.login}-renamed`,
    });
  });

  it("fails before any write: missing claim, unknown login, conflicting claim, account owned by another employee", async () => {
    const w = world();
    // No claim, even though an account exists whose login equals the email prefix: never inferred.
    const noClaim = await authorized([ORG]);
    w.gh.seedUser(
      noClaim.event.employee.email
        .split("@")[0]!
        .replace(/[^A-Za-z0-9-]/g, "-")
        .slice(0, 39),
    );
    expect(
      (await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: noClaim.ids[ORG]! })))
        .code,
    ).toBe("GITHUB_IDENTITY_CLAIM_REQUIRED");
    expect(w.gh.loginLookups).toEqual([]);

    const unknown = await authorized([ORG], { githubLogin: "no-such-user-xyz" });
    expect(
      (await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: unknown.ids[ORG]! })))
        .code,
    ).toBe("GITHUB_IDENTITY_NOT_FOUND");
    expect((await requestRow(unknown.ids[ORG]!)).status).toBe("READY_FOR_PROVISIONING");

    // Employee A links w.user; employee B claims the same account.
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const a = await authorized([ORG], { githubLogin: w.login });
    await provisioner(w).provisionGitHubAccess({ accessRequestId: a.ids[ORG]! });
    const b = await authorized([ORG], { githubLogin: w.login });
    expect(
      (await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: b.ids[ORG]! }))).code,
    ).toBe("GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE");

    expect(w.gh.writes).toBe(0);
  });

  it("stops when a (forged, non-API) changed claim points to another account than the link", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids, employee } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const p = provisioner(w);
    await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    const other = w.gh.seedUser(`${w.login}-x`);
    await handle.db
      .update(externalIdentityClaims)
      .set({ claimedLogin: other.login })
      .where(eq(externalIdentityClaims.employeeId, employee.id));
    const writes = w.gh.writes;
    expect((await ghError(p.provisionGitHubAccess({ accessRequestId: ids[BACKEND]! }))).code).toBe(
      "GITHUB_IDENTITY_CONFLICT",
    );
    expect((await linksFor(employee.id))[0]!.providerSubjectId).toBe(String(w.user.id));
    expect(w.gh.writes).toBe(writes);
  });
});

describe("organization membership", () => {
  it("treats an active membership as satisfied with zero writes", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids, workflowId } = await authorized([ORG], { githubLogin: w.login });
    const r = await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(r).toMatchObject({
      status: "PROVISIONED",
      outcome: "ALREADY_PRESENT",
      organization: w.gh.org,
      teamId: null,
    });
    expect(w.gh.writes).toBe(0);
    expect(await requestRow(ids[ORG]!)).toMatchObject({
      status: "PROVISIONED",
      providerSubjectId: String(w.user.id),
      providerTargetId: w.gh.org,
      providerEvidence: { githubLogin: w.login, organization: w.gh.org, membershipState: "active" },
    });
    expect((await auditFor(workflowId, "github.org_membership_already_present")).length).toBe(1);
  });

  it("invites once, stays PROVISIONING while pending (no invitation spam), then PROVISIONED on acceptance", async () => {
    const w = world({ inviteActivates: false });
    const { ids, workflowId } = await authorized([ORG], { githubLogin: w.login });
    const p = provisioner(w);
    const first = await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(first).toMatchObject({
      status: "PENDING_ACCEPTANCE",
      outcome: "GITHUB_INVITATION_PENDING",
    });
    expect(await requestRow(ids[ORG]!)).toMatchObject({
      status: "PROVISIONING",
      providerState: "INVITATION_PENDING",
    });
    const again = await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(again.outcome).toBe("GITHUB_INVITATION_PENDING");
    expect(w.gh.writes).toBe(1);
    w.gh.acceptInvitation(w.user.id);
    const done = await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(done).toMatchObject({ status: "PROVISIONED", outcome: "PROVISIONED" });
    expect(w.gh.writes).toBe(1);
    expect(await requestRow(ids[ORG]!)).toMatchObject({
      status: "PROVISIONED",
      providerState: null,
    });
    expect(await opsOf("github.ensure_org_membership", workflowId)).toHaveLength(1);
    expect((await auditFor(workflowId, "github.org_invitation_created")).length).toBe(1);
  });

  it("stops on an unexpected org role instead of normalizing it", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "admin" });
    const { ids } = await authorized([ORG], { githubLogin: w.login });
    const err = await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }));
    expect([err.code, err.reason]).toEqual(["PROVISIONING_FAILED", "GITHUB_UNEXPECTED_ROLE"]);
    expect(w.gh.writes).toBe(0);
  });
});

describe("team membership", () => {
  async function orgReady(w: World, resources: string[] = [ORG, BACKEND, FRONTEND]) {
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const ctx = await authorized(resources, { githubLogin: w.login });
    await provisioner(w).provisionGitHubAccess({ accessRequestId: ctx.ids[ORG]! });
    return ctx;
  }

  it("adds the member role once, verifies by read-back and persists team evidence", async () => {
    const w = world();
    const { ids, workflowId } = await orgReady(w);
    const r = await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! });
    expect(r).toMatchObject({
      status: "PROVISIONED",
      outcome: "PROVISIONED",
      teamId: w.backend.id,
      teamSlug: "aoo-backend",
    });
    expect(w.gh.teamMembers.get(`aoo-backend:${w.user.id}`)).toEqual({
      state: "active",
      role: "member",
    });
    expect(await requestRow(ids[BACKEND]!)).toMatchObject({
      status: "PROVISIONED",
      providerTargetId: String(w.backend.id),
      providerEvidence: { teamId: w.backend.id, teamSlug: "aoo-backend", organization: w.gh.org },
    });
    const [op] = await opsOf("github.ensure_team_membership", workflowId);
    expect(op!.idempotencyKey).toContain(`team=${w.backend.id}:user=${w.user.id}`);
    expect((await auditFor(workflowId, "github.team_membership_provisioned")).length).toBe(1);
  });

  it("treats an existing member as satisfied with zero writes", async () => {
    const w = world();
    const { ids } = await orgReady(w);
    w.gh.teamMembers.set(`aoo-frontend:${w.user.id}`, { state: "active", role: "member" });
    const writes = w.gh.writes;
    expect(
      (await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[FRONTEND]! })).outcome,
    ).toBe("ALREADY_PRESENT");
    expect(w.gh.writes).toBe(writes);
  });

  it("stops on a maintainer role (no silent normalization)", async () => {
    const w = world();
    const { ids } = await orgReady(w);
    w.gh.teamMembers.set(`aoo-backend:${w.user.id}`, { state: "active", role: "maintainer" });
    expect(
      (await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! })))
        .reason,
    ).toBe("GITHUB_UNEXPECTED_ROLE");
  });

  it("requires the org dependency PROVISIONED first, with zero GitHub writes", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "member" });
    const { ids } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const err = await ghError(
      provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! }),
    );
    expect(err.code).toBe("DEPENDENCIES_NOT_READY");
    expect([w.gh.writes, w.gh.reads]).toEqual([0, 0]);
    expect((await requestRow(ids[BACKEND]!)).status).toBe("READY_FOR_PROVISIONING");
  });

  it("refuses swapped, missing or unconfigured team targets", async () => {
    const w = world();
    const { ids } = await orgReady(w);
    // Backend resource pointed at the frontend team's slug (with the backend name): mismatch.
    const swapped = targetsFor(w, {
      [BACKEND]: {
        kind: "team",
        resourceId: BACKEND,
        org: w.gh.org,
        teamSlug: "aoo-frontend",
        teamName: "AOO Backend",
      },
    });
    expect(
      (
        await ghError(
          provisioner(w, { targets: swapped }).provisionGitHubAccess({
            accessRequestId: ids[BACKEND]!,
          }),
        )
      ).code,
    ).toBe("GITHUB_TEAM_MISMATCH");
    const missing = targetsFor(w, {
      [BACKEND]: {
        kind: "team",
        resourceId: BACKEND,
        org: w.gh.org,
        teamSlug: "no-such-team",
        teamName: "AOO Backend",
      },
    });
    expect(
      (
        await ghError(
          provisioner(w, { targets: missing }).provisionGitHubAccess({
            accessRequestId: ids[BACKEND]!,
          }),
        )
      ).code,
    ).toBe("GITHUB_TEAM_NOT_FOUND");
    const none = targetsFor(w, { [BACKEND]: null });
    expect(
      (
        await ghError(
          provisioner(w, { targets: none }).provisionGitHubAccess({
            accessRequestId: ids[BACKEND]!,
          }),
        )
      ).code,
    ).toBe("GITHUB_TARGET_NOT_CONFIGURED");
    expect(w.gh.writes).toBe(0);
    expect((await requestRow(ids[BACKEND]!)).status).toBe("READY_FOR_PROVISIONING");
  });
});

describe("authorization boundary: zero GitHub calls", () => {
  it("DENIED/AWAITING_APPROVAL/wrong provider/forged chains/catalog mismatch never reach GitHub", async () => {
    const w = world();
    const p = provisioner(w);
    const denied = await authorized(["aws-prod"], {}, { employmentType: "CONTRACTOR" });
    const awaiting = await authorized(["aws-prod"]);
    const okta = await authorized(["okta-engineering-group"]);
    const forgedDeny = await authorized(["aws-prod"], {}, { employmentType: "CONTRACTOR" });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'POLICY' WHERE id = ${forgedDeny.ids["aws-prod"]}`,
    );
    const pending = await authorized(["aws-prod"]);
    const pendingRow = await requestRow(pending.ids["aws-prod"]!);
    await pending.snOps.execute(pendingRow.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'APPROVAL', approval_id = (SELECT id FROM approvals WHERE external_operation_id = ${pendingRow.externalOperationId}) WHERE id = ${pendingRow.id}`,
    );
    const mismatched = await authorized([ORG], { githubLogin: w.login });
    await handle.db.execute(
      sql`UPDATE access_requests SET resource_id = 'github-team-backend' WHERE id = ${mismatched.ids[ORG]}`,
    );

    const cases: [string, string][] = [
      [denied.ids["aws-prod"]!, "NOT_ELIGIBLE"],
      [awaiting.ids["aws-prod"]!, "NOT_ELIGIBLE"],
      [okta.ids["okta-engineering-group"]!, "PROVIDER_MISMATCH"],
      [forgedDeny.ids["aws-prod"]!, "AUTHORIZATION_CHAIN_INVALID"],
      [pendingRow.id, "AUTHORIZATION_CHAIN_INVALID"],
      [mismatched.ids[ORG]!, "AUTHORIZATION_CHAIN_INVALID"],
    ];
    for (const [id, code] of cases)
      expect((await ghError(p.provisionGitHubAccess({ accessRequestId: id }))).code).toBe(code);

    const base = CATALOG_RELEASES[0]!;
    const altered = structuredClone(base.document) as {
      resources: { resourceId: string; description: string }[];
    };
    altered.resources.find((r) => r.resourceId === ORG)!.description = "Altered.";
    const wrongCatalog = new CatalogRegistry({
      releases: [{ document: altered, catalogHash: new ResourceCatalog(altered).catalogHash }],
      currentVersion: "1.0.0",
    });
    const clean = await authorized([ORG], { githubLogin: w.login });
    expect(
      (
        await ghError(
          provisioner(w, { catalogs: wrongCatalog }).provisionGitHubAccess({
            accessRequestId: clean.ids[ORG]!,
          }),
        )
      ).code,
    ).toBe("CATALOG_UNAVAILABLE");
    expect([w.gh.writes, w.gh.reads]).toEqual([0, 0]);
  });
});

describe("uncertain outcomes and failures", () => {
  it("reconciles lost org and team responses without a second write", async () => {
    const w = world();
    w.gh.orgWriteBehaviors.push("lost-after-write");
    w.gh.teamWriteBehaviors.push("lost-after-write");
    const { ids } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const p = provisioner(w);
    expect((await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! })).status).toBe(
      "PROVISIONED",
    );
    expect((await p.provisionGitHubAccess({ accessRequestId: ids[BACKEND]! })).status).toBe(
      "PROVISIONED",
    );
    expect(w.gh.writes).toBe(2);
  });

  it("an uncertain invitation reconciles to PENDING and is never re-sent", async () => {
    const w = world({ inviteActivates: false });
    w.gh.orgWriteBehaviors.push("lost-after-write");
    const { ids } = await authorized([ORG], { githubLogin: w.login });
    const p = provisioner(w);
    expect((await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! })).outcome).toBe(
      "GITHUB_INVITATION_PENDING",
    );
    await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(w.gh.writes).toBe(1);
  });

  it("releases on 429 and 5xx and completes on re-invocation; auth failures are terminal and sanitized", async () => {
    const w = world();
    w.gh.orgWriteBehaviors.push("429", "503-no-effect");
    const { ids, workflowId } = await authorized([ORG], { githubLogin: w.login });
    const p = provisioner(w);
    expect((await ghError(p.provisionGitHubAccess({ accessRequestId: ids[ORG]! }))).code).toBe(
      "RETRY_LATER",
    );
    expect((await ghError(p.provisionGitHubAccess({ accessRequestId: ids[ORG]! }))).code).toBe(
      "RETRY_LATER",
    );
    expect((await requestRow(ids[ORG]!)).status).toBe("PROVISIONING");
    expect((await p.provisionGitHubAccess({ accessRequestId: ids[ORG]! })).status).toBe(
      "PROVISIONED",
    );
    expect((await opsOf("github.ensure_org_membership", workflowId))[0]!.attempts).toBe(3);

    const w2 = world();
    const token = "ghp_SecretTokenABCDEFGHIJKLMNOPQRSTUV0123456";
    w2.gh.setOrgMembership = async () => {
      w2.gh.writes++;
      throw new (await import("@aoo/github")).GitHubError(
        "AUTHENTICATION_FAILED",
        "setOrgMembership",
        `HTTP 401 Authorization: Bearer ${token}`,
        { status: 401 },
      );
    };
    const c2 = await authorized([ORG], { githubLogin: w2.login });
    const err = await ghError(
      provisioner(w2).provisionGitHubAccess({ accessRequestId: c2.ids[ORG]! }),
    );
    expect([err.code, err.reason]).toEqual(["PROVISIONING_FAILED", "AUTHENTICATION_FAILED"]);
    const [op] = await opsOf("github.ensure_org_membership", c2.workflowId);
    expect(JSON.stringify(op)).not.toContain(token);
    expect(w2.gh.writes).toBe(1);
  });
});

describe("concurrency and crash recovery", () => {
  it.each([2, 6])(
    "%i concurrent provisions of one org request → one write, one operation, one transition",
    async (n) => {
      const w = world();
      const { ids, workflowId } = await authorized([ORG], { githubLogin: w.login });
      const results = await Promise.allSettled(
        Array.from({ length: n }, () =>
          provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }),
        ),
      );
      for (const r of results) expect(r.status).toBe("fulfilled");
      expect(w.gh.writes).toBe(1);
      expect(await opsOf("github.ensure_org_membership", workflowId)).toHaveLength(1);
      expect((await auditFor(workflowId, "resource.provisioned")).length).toBe(1);
    },
  );

  it("2 concurrent provisions of one team request; org and team started together (team waits)", async () => {
    const w = world();
    const { ids, workflowId } = await authorized([ORG, BACKEND], { githubLogin: w.login });
    const [org, team] = await Promise.allSettled([
      provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }),
      provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! }),
    ]);
    expect(org.status).toBe("fulfilled");
    if (team.status === "rejected")
      expect((team.reason as GitHubProvisioningError).code).toBe("DEPENDENCIES_NOT_READY");
    const teams = await Promise.allSettled(
      [0, 1].map(() => provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! })),
    );
    for (const r of teams) expect(r.status).toBe("fulfilled");
    expect(w.gh.writes).toBe(2); // one org write, one team write
    expect(await opsOf("github.ensure_team_membership", workflowId)).toHaveLength(1);
    expect((await auditFor(workflowId, "resource.provisioned")).length).toBe(2);
  });

  it.each([
    ["org invitation/write", ORG, "github.ensure_org_membership", "orgWriteBehaviors"],
    ["team membership write", BACKEND, "github.ensure_team_membership", "teamWriteBehaviors"],
  ] as const)(
    "crash after the %s may have happened: next owner reconciles, stale owner writes nothing",
    async (_l, resource, type, queue) => {
      const w = world();
      const ctx = await authorized([ORG, BACKEND], { githubLogin: w.login });
      if (resource === BACKEND)
        await provisioner(w).provisionGitHubAccess({ accessRequestId: ctx.ids[ORG]! });
      let resume!: () => void;
      w.gh[queue].push({ writeThenHold: new Promise<void>((r) => (resume = r)) });
      const writesBefore = w.gh.writes;
      const stale = provisioner(w, { ownerId: "stale" })
        .provisionGitHubAccess({ accessRequestId: ctx.ids[resource]! })
        .then(
          (r) => (r.replayed ? "converged-without-writes" : "wrote"),
          (e: GitHubProvisioningError) => e.code,
        );
      await new Promise((r) => setTimeout(r, 150));
      await handle.db.execute(
        sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE workflow_id = ${ctx.workflowId} AND operation_type = ${type}`,
      );
      const recovered = await provisioner(w, { ownerId: "recovery" }).provisionGitHubAccess({
        accessRequestId: ctx.ids[resource]!,
      });
      expect(recovered.status).toBe("PROVISIONED");
      resume();
      expect(await stale).toBe("converged-without-writes");
      expect(w.gh.writes - writesBefore).toBe(1);
      expect(await opsOf(type, ctx.workflowId)).toHaveLength(1);
      // Replay after success: no GitHub call at all.
      const calls = w.gh.reads + w.gh.writes;
      expect(
        (await provisioner(w).provisionGitHubAccess({ accessRequestId: ctx.ids[resource]! }))
          .replayed,
      ).toBe(true);
      expect(w.gh.reads + w.gh.writes).toBe(calls);
    },
  );
});

describe("HR-recorded GitHub identity claim (operator input)", () => {
  const claimsOf = (employeeId: string) =>
    handle.db
      .select()
      .from(externalIdentityClaims)
      .where(eq(externalIdentityClaims.employeeId, employeeId));

  it("without a claim: non-terminal CLAIM_REQUIRED, 0 GitHub calls; resumes once submitted", async () => {
    const w = world();
    const { ids, workflowId, employee } = await authorized([ORG, BACKEND]);
    const err = await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }));
    expect([err.code, err.retryable]).toEqual(["GITHUB_IDENTITY_CLAIM_REQUIRED", true]);
    expect([w.gh.reads, w.gh.writes]).toEqual([0, 0]);
    expect(await requestRow(ids[ORG]!)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      provisioningErrorCode: null,
    });
    expect(await identities().getStatus(workflowId)).toMatchObject({
      identityRequired: true,
      identity: { state: "NOT_SUBMITTED", claimedLogin: null, resolvedLogin: null },
      resources: [
        { resourceId: ORG, progress: "WAITING_FOR_IDENTITY" },
        { resourceId: BACKEND, progress: "WAITING_FOR_IDENTITY" },
      ],
    });

    const submitted = await identities().submitClaim({
      operatorId: OPERATOR,
      workflowId,
      githubLogin: w.login,
    });
    expect(submitted).toMatchObject({
      changed: true,
      identity: { state: "SUBMITTED", claimedLogin: w.login },
      resources: [{ progress: "WAITING_TO_START" }, { progress: "WAITING_TO_START" }],
    });
    expect([w.gh.reads, w.gh.writes]).toEqual([0, 0]); // submission never calls GitHub

    const org = await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(org).toMatchObject({ status: "PROVISIONED", identity: "RESOLVED" });
    expect(await linksFor(employee.id)).toMatchObject([
      { providerSubjectId: String(w.user.id), providerLogin: w.login },
    ]);
    expect(await identities().getStatus(workflowId)).toMatchObject({
      identity: { state: "RESOLVED", resolvedLogin: w.login },
      resources: [
        { resourceId: ORG, progress: "CONNECTED" },
        { resourceId: BACKEND, progress: "WAITING_TO_START" },
      ],
    });
  });

  it("is idempotent for the same login (also case-insensitively): one claim, one audit", async () => {
    const w = world();
    const { workflowId, employee } = await authorized([ORG]);
    const svc = identities();
    expect(
      (await svc.submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: w.login })).changed,
    ).toBe(true);
    expect(
      (await svc.submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: w.login })).changed,
    ).toBe(false);
    expect(
      (
        await svc.submitClaim({
          operatorId: OPERATOR,
          workflowId,
          githubLogin: w.login.toUpperCase(),
        })
      ).changed,
    ).toBe(false);
    expect(await claimsOf(employee.id)).toMatchObject([{ claimedLogin: w.login }]);
    expect(await auditFor(workflowId, "github.identity_claim_")).toHaveLength(1);
  });

  it("allows a correction before linking (audited) and provisions the corrected account", async () => {
    const w = world();
    const { ids, workflowId, employee } = await authorized([ORG], { githubLogin: "typo-login" });
    const corrected = await identities().submitClaim({
      operatorId: OPERATOR,
      workflowId,
      githubLogin: w.login,
    });
    expect(corrected).toMatchObject({ changed: true, identity: { claimedLogin: w.login } });
    expect(await claimsOf(employee.id)).toHaveLength(1);
    const [changed] = await auditFor(workflowId, "github.identity_claim_changed");
    expect(changed!.payload).toMatchObject({ previousLogin: "typo-login", claimedLogin: w.login });
    await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect(w.gh.loginLookups).toEqual([w.login]);
    expect((await linksFor(employee.id))[0]!.providerSubjectId).toBe(String(w.user.id));
  });

  it("after linking: the same account is a no-op, a different login is GITHUB_IDENTITY_ALREADY_LINKED", async () => {
    const w = world();
    const { ids, workflowId, employee } = await authorized([ORG, BACKEND], {
      githubLogin: w.login,
    });
    await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    const other = w.gh.seedUser(`${w.login}-other`);
    await expect(
      identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: other.login }),
    ).rejects.toMatchObject({ code: "GITHUB_IDENTITY_ALREADY_LINKED" });
    expect(
      (await identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: w.login }))
        .changed,
    ).toBe(false);
    expect(await claimsOf(employee.id)).toMatchObject([{ claimedLogin: w.login }]);
    expect((await linksFor(employee.id))[0]!.providerSubjectId).toBe(String(w.user.id));
    // Renamed at GitHub (same id): the new canonical login is the same identity.
    w.user.login = `${w.login}-renamed`;
    await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[BACKEND]! });
    expect(
      (
        await identities().submitClaim({
          operatorId: OPERATOR,
          workflowId,
          githubLogin: w.user.login,
        })
      ).changed,
    ).toBe(false);
  });

  it("a claim changed while it is being resolved is not linked (retry later, then the new claim)", async () => {
    const w = world();
    const second = w.gh.seedUser(`${w.login}-second`);
    const { ids, workflowId, employee } = await authorized([ORG], { githubLogin: w.login });
    const lookup = w.gh.getUserByLogin.bind(w.gh);
    let raced = false;
    w.gh.getUserByLogin = async (login: string) => {
      const user = await lookup(login);
      if (!raced) {
        raced = true;
        await identities().submitClaim({
          operatorId: OPERATOR,
          workflowId,
          githubLogin: second.login,
        });
      }
      return user;
    };
    const err = await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }));
    expect(err.code).toBe("RETRY_LATER");
    expect(await linksFor(employee.id)).toHaveLength(0);
    await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! });
    expect((await linksFor(employee.id))[0]!.providerSubjectId).toBe(String(second.id));
  });

  it("serializes concurrent different submissions into one claim row", async () => {
    const { workflowId, employee } = await authorized([ORG]);
    const logins = ["alpha-user", "bravo-user", "charlie-user", "delta-user"];
    await Promise.all(
      logins.map((githubLogin) =>
        identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin }),
      ),
    );
    const rows = await claimsOf(employee.id);
    expect(rows).toHaveLength(1);
    expect(logins).toContain(rows[0]!.claimedLogin);
    expect((await auditFor(workflowId, "github.identity_claim_")).length).toBe(logins.length);
  });

  it("rejects malformed usernames, unknown and ended workflows, and never infers a login", async () => {
    const { workflowId, employee } = await authorized([ORG]);
    for (const bad of [
      "",
      " octocat",
      "octo_cat",
      "-octo",
      "octo--cat",
      "<b>x</b>",
      "a".repeat(40),
      { login: "x" },
      42,
    ]) {
      await expect(
        identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: bad }),
      ).rejects.toMatchObject({ code: "INVALID_GITHUB_LOGIN" });
    }
    expect(await claimsOf(employee.id)).toHaveLength(0);
    await expect(
      identities().submitClaim({
        operatorId: OPERATOR,
        workflowId: "00000000-0000-4000-8000-000000000000",
        githubLogin: "octocat",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "FAILED",
      expectedVersion: wf.version,
      actor: "test",
      reason: "synthetic",
    });
    await expect(
      identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: "octocat" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_ACTIVE" });
    // Status never proposes a login from the employee's email or name.
    expect((await identities().getStatus(workflowId)).identity.claimedLogin).toBeNull();
  });
});

describe("HR claim provenance", () => {
  it("records the operator as the audit actor and requires an operator id", async () => {
    const w = world();
    const { workflowId, employee } = await authorized([ORG]);
    for (const operatorId of ["", " spaced", "a".repeat(65), "<b>"]) {
      await expect(
        identities().submitClaim({ operatorId, workflowId, githubLogin: w.login }),
      ).rejects.toMatchObject({ code: "INVALID_OPERATOR_ID" });
    }
    await identities().submitClaim({ operatorId: OPERATOR, workflowId, githubLogin: w.login });
    const [recorded] = await auditFor(workflowId, "github.identity_claim_recorded");
    expect(recorded).toMatchObject({
      actor: `hr:${OPERATOR}`,
      payload: { employeeId: employee.id, claimedLogin: w.login, source: "HR_INPUT" },
    });
    expect(await identities().getStatus(workflowId)).toMatchObject({
      employee: { workEmail: employee.email, firstName: employee.firstName },
    });
  });

  it("ignores a legacy non-HR claim (CLAIM_REQUIRED, 0 GitHub calls) until HR records one", async () => {
    const w = world();
    const { ids, workflowId, employee } = await authorized([ORG]);
    await handle.db.insert(externalIdentityClaims).values({
      employeeId: employee.id,
      provider: "github",
      claimedLogin: w.login,
      source: "EMPLOYEE_INPUT",
      workflowId,
    });
    const err = await ghError(provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! }));
    expect(err.code).toBe("GITHUB_IDENTITY_CLAIM_REQUIRED");
    expect([w.gh.reads, w.gh.writes]).toEqual([0, 0]);
    expect((await identities().getStatus(workflowId)).identity.state).toBe("NOT_SUBMITTED");
    const res = await identities().submitClaim({
      operatorId: OPERATOR,
      workflowId,
      githubLogin: w.login,
    });
    expect(res.changed).toBe(true);
    const [row] = await handle.db
      .select()
      .from(externalIdentityClaims)
      .where(eq(externalIdentityClaims.employeeId, employee.id));
    expect(row).toMatchObject({ source: "HR_INPUT", recordedBy: OPERATOR });
    const [audit] = await auditFor(workflowId, "github.identity_claim_recorded");
    expect(audit!.payload).toMatchObject({ replacedSource: "EMPLOYEE_INPUT" });
    expect(
      (await provisioner(w).provisionGitHubAccess({ accessRequestId: ids[ORG]! })).status,
    ).toBe("PROVISIONED");
  });
});
