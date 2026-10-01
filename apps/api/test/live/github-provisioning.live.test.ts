// LIVE M7B test against a real GitHub organization. Never part of pnpm test / test:integration.
// Run explicitly: `pnpm test:github:live`. Needs GITHUB_TOKEN, GITHUB_ORG, GITHUB_TEST_USERNAME,
// at least one team target (GITHUB_BACKEND_TEAM_SLUG/NAME or GITHUB_FRONTEND_TEAM_SLUG/NAME),
// ONBOARDING_ADMIN_TOKEN and HRIS_WEBHOOK_SECRET in the git-ignored .env; otherwise it fails with
// LIVE_GITHUB_BLOCKED before any write.
//
// The API runs in-process (buildApp + inject) on a throwaway database:
//   signed HRIS webhook (no GitHub data) → scripted agent → policy (ALLOW)
//   → HR records GITHUB_TEST_USERNAME via POST /admin/onboarding/:id/github-identity
//     (Bearer ONBOARDING_ADMIN_TOKEN, X-Operator-Id m7b-live-hr) → real GitHub provisioning.
// GITHUB_TEST_USERNAME is test-fixture input: never HRIS, never an employee token, never inferred.
//
// Fixture: a controlled, non-owner account. The test follows its current org state:
//   - not in the org: the system sends the real org invitation (write), the org request stays
//     PROVISIONING/INVITATION_PENDING, re-invoking never re-sends it, and the team waits
//     (DEPENDENCIES_NOT_READY). The fixture then accepts the invite on GitHub (the one human
//     step: it proves account ownership) and the test is run again;
//   - invitation pending: nothing is re-sent; still waiting for acceptance;
//   - active member: the org is ALREADY_PRESENT (no write) and the team gets one real write.
// Memberships are never removed, so each team proves a write once; the active phase picks the
// first configured team the fixture is not on. No model call (scripted agent), no
// ServiceNow call (policy-ALLOWed resources). Tokens and headers are never printed.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  auditEvents,
  createDatabase,
  externalIdentities,
  externalIdentityClaims,
  externalOperations,
  onboardingWorkflows,
  type DatabaseHandle,
} from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import {
  createGitHubClient,
  loadGitHubConfig,
  loadGitHubTargets,
  type GitHubClient,
  type GitHubTarget,
} from "@aoo/github";
import {
  createAccessAuthorizationService,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubProvisioningService,
  createRoleAccessRecommendationService,
  createWorkflowService,
  type GitHubGateway,
  type GitHubProvisioningError,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import { hrisSignatureHeaders } from "@aoo/webhooks";
import { and, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const ORG = "github-org-membership";
const TEAM_RESOURCES = ["github-team-backend", "github-team-frontend"];
const OPERATOR = "m7b-live-hr";
export const LIVE_REPORT = join(tmpdir(), "aoo-m7b-github-live-report.json");

let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;
let client: GitHubClient;
let targets: ReadonlyMap<string, GitHubTarget>;
let fixture: string;
let teamResource: string;
let adminToken: string;
let hrisSecret: string;
/** The fixture's org membership at preflight: decides which phase this run proves. */
let orgState: "none" | "pending" | "active";

function blocked(reason: string): never {
  throw new Error(`LIVE_GITHUB_BLOCKED: ${reason}`);
}

/** Counts every GitHub call the provisioning path makes (reads and writes). */
function counting(gh: GitHubClient) {
  const writes: string[] = [];
  let reads = 0;
  const read =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A) => {
      reads++;
      return fn(...a);
    };
  const gateway: GitHubGateway = {
    getUserByLogin: read((...a: Parameters<GitHubClient["getUserByLogin"]>) =>
      gh.getUserByLogin(...a),
    ),
    getUserById: read((...a: Parameters<GitHubClient["getUserById"]>) => gh.getUserById(...a)),
    getOrganization: read((...a: Parameters<GitHubClient["getOrganization"]>) =>
      gh.getOrganization(...a),
    ),
    getOrgMembership: read((...a: Parameters<GitHubClient["getOrgMembership"]>) =>
      gh.getOrgMembership(...a),
    ),
    getTeam: read((...a: Parameters<GitHubClient["getTeam"]>) => gh.getTeam(...a)),
    getTeamMembership: read((...a: Parameters<GitHubClient["getTeamMembership"]>) =>
      gh.getTeamMembership(...a),
    ),
    setOrgMembership: (...a) => (writes.push("setOrgMembership"), gh.setOrgMembership(...a)),
    addTeamMembership: (...a) => (writes.push("addTeamMembership"), gh.addTeamMembership(...a)),
  };
  return { gateway, writes, calls: () => reads + writes.length };
}

beforeAll(async () => {
  // Read-only preflight: no write happens unless every check passes.
  let config;
  try {
    config = loadGitHubConfig(process.env);
    targets = loadGitHubTargets(process.env);
  } catch (err) {
    blocked((err as Error).message);
  }
  fixture = process.env.GITHUB_TEST_USERNAME?.trim() ?? "";
  if (!fixture) blocked("GITHUB_TEST_USERNAME is not configured");
  adminToken = process.env.ONBOARDING_ADMIN_TOKEN?.trim() ?? "";
  if (adminToken.length < 32)
    blocked("ONBOARDING_ADMIN_TOKEN (>= 32 characters) is not configured");
  hrisSecret = process.env.HRIS_WEBHOOK_SECRET?.trim() ?? "";
  if (hrisSecret.length < 32) blocked("HRIS_WEBHOOK_SECRET is not configured");
  const orgTarget = targets.get(ORG);
  if (!orgTarget) blocked("GITHUB_ORG is not configured");
  client = createGitHubClient(config);
  try {
    await client.verifyCredentials();
  } catch (err) {
    blocked(`token or API URL rejected (${(err as { code?: string }).code ?? "error"})`);
  }
  if (!(await client.getOrganization(orgTarget.org))) blocked("the configured org does not exist");
  const user = await client.getUserByLogin(fixture);
  if (!user || user.type !== "User") {
    blocked("GITHUB_TEST_USERNAME is not an existing user account");
  }
  const m = await client.getOrgMembership(orgTarget.org, fixture);
  if (m && m.role !== "member") {
    blocked(
      `the fixture holds org role "${m.role}"; M7B grants member only (use a non-owner account)`,
    );
  }
  if (m && m.state !== "active" && m.state !== "pending")
    blocked(`unexpected org state ${m.state}`);
  orgState = (m?.state as "active" | "pending" | undefined) ?? "none";
  const candidates: string[] = [];
  for (const resourceId of TEAM_RESOURCES) {
    const t = targets.get(resourceId);
    if (t?.kind !== "team") continue;
    const team = await client.getTeam(t.org, t.teamSlug);
    if (!team || team.slug !== t.teamSlug || team.name !== t.teamName) {
      blocked(`${resourceId}: the configured team slug/name does not match GitHub exactly`);
    }
    if (!(await client.getTeamMembership(t.org, t.teamSlug, fixture))) candidates.push(resourceId);
  }
  if (candidates.length === 0) {
    blocked("no configured team without the fixture; memberships are never removed for cleanup");
  }
  teamResource = candidates[0]!;

  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
  try {
    app = await buildApp(
      loadConfig({ ...process.env, DATABASE_URL: testDb.url, LOG_LEVEL: "silent" }),
    );
  } catch (err) {
    blocked(`API config invalid: ${(err as Error).message.split("\n")[0]}`);
  }
});
afterAll(async () => {
  await app?.close();
  await handle?.close();
  await testDb?.drop();
});

const recordClaim = (workflowId: string, githubLogin: string, headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: `/admin/onboarding/${workflowId}/github-identity`,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify({ githubLogin }),
  });

describe("M7B live: HR-recorded GitHub identity → real org and team membership", () => {
  it("records the claim over HTTP, then invites (not a member) or writes the team once and replays (active member)", async () => {
    const db = handle.db;
    const catalogs = loadCatalogRegistry();
    const policies = loadPolicyRegistry(catalogs);
    const workflows = createWorkflowService(db);
    const runId = Date.now().toString(36);
    const hr = { authorization: `Bearer ${adminToken}`, "x-operator-id": OPERATOR };
    const { gateway, writes, calls } = counting(client);

    // 1. Synthetic hire through the signed HRIS webhook (no GitHub data).
    const event = {
      eventId: `evt-m7b-live-${runId}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: `TEST-EMP-M7B-${runId}`,
      employee: { firstName: "Synthetic", lastName: "M7bFixture", email: "aoo.m7b@example.com" },
      role: "Backend Software Engineer",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
      jobDescription: "SYNTHETIC M7B live GitHub fixture. Not real data.",
      managerId: "TEST-MGR-M7B",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
    };
    const body = JSON.stringify(event);
    const intake = await app.inject({
      method: "POST",
      url: "/webhooks/hris",
      headers: {
        "content-type": "application/json",
        ...hrisSignatureHeaders(body, hrisSecret),
      },
      payload: body,
    });
    expect(intake.statusCode).toBe(202);
    const workflowId = intake.json().workflowId as string;

    // 2. Scripted agent → policy authorization (ALLOW, no ServiceNow).
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m7b-live",
    });
    const agent = createRoleAccessAgent({
      provider: createScriptedModelProvider([outputOf(ORG, teamResource)]),
    });
    const { agentRunId } = await createRoleAccessRecommendationService(db, {
      agent,
      catalogs,
    }).recommendAccess({ workflowId });
    const authz = await createAccessAuthorizationService(db, {
      policies,
      catalogs,
      workflows,
      externalOperations: createExternalOperationService(db, {}),
    }).authorizeAgentRun({ agentRunId });
    const ids = Object.fromEntries(authz.resources.map((r) => [r.resourceId, r]));
    for (const r of [ORG, teamResource]) {
      expect(ids[r]).toMatchObject({ decision: "ALLOW", status: "READY_FOR_PROVISIONING" });
    }
    const employeeId = (
      await db.select().from(onboardingWorkflows).where(eq(onboardingWorkflows.id, workflowId))
    )[0]!.employeeId;
    const decisionsOf = () =>
      db.select().from(accessDecisions).where(eq(accessDecisions.workflowId, workflowId));
    const requestsOf = () =>
      db.select().from(accessRequests).where(eq(accessRequests.workflowId, workflowId));
    const claimsOf = () =>
      db
        .select()
        .from(externalIdentityClaims)
        .where(eq(externalIdentityClaims.employeeId, employeeId));
    const githubOpsOf = () =>
      db
        .select()
        .from(externalOperations)
        .where(
          and(
            eq(externalOperations.workflowId, workflowId),
            eq(externalOperations.provider, "github"),
          ),
        );
    const claimAudits = () =>
      db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workflowId, workflowId),
            like(auditEvents.eventType, "github.identity_claim_%"),
          ),
        );
    const decisionsBefore = await decisionsOf();
    const requestsBefore = await requestsOf();

    // 3. Operator authorization: missing or invalid tokens are refused and change nothing.
    for (const headers of [
      { "x-operator-id": OPERATOR },
      {
        authorization: "Bearer not-the-onboarding-admin-token-0123456789",
        "x-operator-id": OPERATOR,
      },
    ]) {
      const denied = await recordClaim(workflowId, fixture, headers);
      expect([denied.statusCode, denied.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
    }
    expect(await claimsOf()).toHaveLength(0);
    expect(calls()).toBe(0);

    // 4. HR records the username the employee provided: identity data only.
    const first = await recordClaim(workflowId, fixture, hr);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      changed: true,
      identity: { state: "SUBMITTED", claimedLogin: fixture, resolvedLogin: null },
    });
    const [claim] = await claimsOf();
    expect(await claimsOf()).toHaveLength(1);
    expect(claim).toMatchObject({
      provider: "github",
      claimedLogin: fixture,
      source: "HR_INPUT",
      recordedBy: OPERATOR,
      workflowId,
    });
    expect(calls()).toBe(0); // recording never calls GitHub
    expect(await decisionsOf()).toEqual(decisionsBefore); // no policy decision changed
    expect(await requestsOf()).toEqual(requestsBefore); // provisioning hasn't started
    expect(await githubOpsOf()).toHaveLength(0);
    expect(await claimAudits()).toHaveLength(1);

    // 5. The same username again: idempotent, no mutation, no GitHub call.
    const again = await recordClaim(workflowId, fixture, hr);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ changed: false, identity: { claimedLogin: fixture } });
    expect(await claimsOf()).toEqual([claim]);
    expect(await claimAudits()).toHaveLength(1);
    expect(calls()).toBe(0);

    // 6. A bad token after recording still changes nothing.
    const hijack = await recordClaim(workflowId, `${fixture}-x`.slice(0, 39), {
      authorization: "Bearer not-the-onboarding-admin-token-0123456789",
      "x-operator-id": OPERATOR,
    });
    expect(hijack.statusCode).toBe(401);
    expect(await claimsOf()).toEqual([claim]);
    expect(calls()).toBe(0);

    // 7. Provision through the durable layer with the real GitHub client.
    const service = createGitHubProvisioningService(db, {
      catalogs,
      externalOperations: createExternalOperationService(db, {
        handlers: createGitHubHandlers(gateway),
        reconcile: { attempts: 5, delayMs: 2000 },
      }),
      github: gateway,
      targets,
      ownerId: "m7b-live",
      leaseMs: 120_000,
    });
    const org = await service.provisionGitHubAccess({ accessRequestId: ids[ORG]!.accessRequestId });
    if (orgState !== "active") {
      // Invitation phase: the system invites the exact resolved account; only its owner can accept.
      expect(org).toMatchObject({
        status: "PENDING_ACCEPTANCE",
        outcome: "GITHUB_INVITATION_PENDING",
        identity: "RESOLVED",
      });
      // A fresh invitation is one real write; an invitation pending from an earlier run is never re-sent.
      expect(writes).toEqual(orgState === "none" ? ["setOrgMembership"] : []);
      const invited = await client.getOrgMembership(targets.get(ORG)!.org, fixture);
      expect(invited).toMatchObject({ state: "pending", role: "member" });
      const [pendingRow] = (await requestsOf()).filter((r) => r.resourceId === ORG);
      expect(pendingRow).toMatchObject({
        status: "PROVISIONING",
        providerState: "INVITATION_PENDING",
      });
      const writesAfterInvite = [...writes];
      const again = await service.provisionGitHubAccess({
        accessRequestId: ids[ORG]!.accessRequestId,
      });
      expect(again.outcome).toBe("GITHUB_INVITATION_PENDING");
      expect(writes).toEqual(writesAfterInvite); // never re-sent
      const teamWait = await service
        .provisionGitHubAccess({ accessRequestId: ids[teamResource]!.accessRequestId })
        .then(
          () => "provisioned",
          (err: GitHubProvisioningError) => err.code,
        );
      expect(teamWait).toBe("DEPENDENCIES_NOT_READY");
      expect(writes).toEqual(writesAfterInvite); // the team waits: zero writes
      const inviteLinks = await db
        .select()
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.employeeId, employeeId),
            eq(externalIdentities.provider, "github"),
          ),
        );
      expect(inviteLinks).toMatchObject([{ providerSubjectId: String(org.githubUserId) }]);
      expect((await workflows.getWorkflow(workflowId))!.workflow.state).not.toBe("COMPLETED");
      writeFileSync(
        LIVE_REPORT,
        JSON.stringify(
          {
            phase: orgState === "none" ? "INVITATION_SENT" : "AWAITING_ACCEPTANCE",
            next: "accept the aoo-sandbox invitation as the fixture account, then run again",
            claimSource: claim!.source,
            claimRecordedBy: claim!.recordedBy,
            claimedLogin: claim!.claimedLogin,
            resolvedLogin: org.githubLogin,
            githubUserId: org.githubUserId,
            organization: org.organization,
            orgOutcome: org.outcome,
            orgAccessRequestState: pendingRow!.status,
            orgProviderState: pendingRow!.providerState,
            githubOrgMembership: invited && { state: invited.state, role: invited.role },
            teamResource,
            teamOutcome: teamWait,
            externalIdentityCount: inviteLinks.length,
            providerWrites: writes,
          },
          null,
          2,
        ),
      );
      return;
    }
    expect(org).toMatchObject({
      status: "PROVISIONED",
      outcome: "ALREADY_PRESENT",
      identity: "RESOLVED",
    });
    expect(writes).toEqual([]); // active org member: no invitation sent
    const links = await db
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.employeeId, employeeId),
          eq(externalIdentities.provider, "github"),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      providerSubjectId: String(org.githubUserId),
      providerLogin: org.githubLogin,
    });
    expect(org.githubLogin.toLowerCase()).toBe(fixture.toLowerCase());

    const [orgRow] = await requestsOf().then((rs) => rs.filter((r) => r.resourceId === ORG));
    expect(orgRow!.status).toBe("PROVISIONED");
    const [teamReady] = await requestsOf().then((rs) =>
      rs.filter((r) => r.resourceId === teamResource),
    );
    expect(teamReady!.status).toBe("READY_FOR_PROVISIONING");

    const team = await service.provisionGitHubAccess({
      accessRequestId: ids[teamResource]!.accessRequestId,
    });
    expect(team).toMatchObject({
      status: "PROVISIONED",
      outcome: "PROVISIONED",
      identity: "LINKED",
    });
    expect(writes).toEqual(["addTeamMembership"]);

    // 8. Authoritative read-back from GitHub.
    const target = targets.get(teamResource) as Extract<GitHubTarget, { kind: "team" }>;
    const membership = await client.getTeamMembership(target.org, target.teamSlug, fixture);
    expect(membership?.role).toBe("member");

    // 9. Replay: same identity and team, no GitHub call, no second operation or transition.
    const callsBeforeReplay = calls();
    const replayOrg = await service.provisionGitHubAccess({
      accessRequestId: ids[ORG]!.accessRequestId,
    });
    const replayTeam = await service.provisionGitHubAccess({
      accessRequestId: ids[teamResource]!.accessRequestId,
    });
    expect([replayOrg.replayed, replayTeam.replayed]).toEqual([true, true]);
    expect(replayTeam).toMatchObject({ githubUserId: team.githubUserId, teamId: team.teamId });
    expect(calls()).toBe(callsBeforeReplay);
    expect(writes).toEqual(["addTeamMembership"]);
    const github = await githubOpsOf();
    const teamOps = github.filter((o) => o.operationType === "github.ensure_team_membership");
    expect(github.map((o) => o.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(teamOps).toHaveLength(1);
    const provisionedAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "resource.provisioned"),
        ),
      );
    expect(provisionedAudits).toHaveLength(2);

    // 10. Persisted evidence; M7B never completes the workflow.
    const [teamRow] = await requestsOf().then((rs) =>
      rs.filter((r) => r.resourceId === teamResource),
    );
    expect(teamRow).toMatchObject({
      status: "PROVISIONED",
      provisioningOperationId: teamOps[0]!.id,
      providerSubjectId: String(team.githubUserId),
      providerTargetId: String(team.teamId),
      providerEvidence: {
        githubLogin: team.githubLogin,
        organization: target.org,
        teamId: team.teamId,
        teamSlug: target.teamSlug,
      },
    });
    expect(teamRow!.provisionedAt).toBeInstanceOf(Date);
    const finalWorkflow = (await workflows.getWorkflow(workflowId))!.workflow;
    expect(finalWorkflow.state).not.toBe("COMPLETED");
    const status = await app.inject({
      method: "GET",
      url: `/admin/onboarding/${workflowId}/github-identity`,
      headers: hr,
    });
    expect(status.json().identity).toMatchObject({
      state: "RESOLVED",
      resolvedLogin: org.githubLogin,
    });

    writeFileSync(
      LIVE_REPORT,
      JSON.stringify(
        {
          claimSource: claim!.source,
          claimRecordedBy: claim!.recordedBy,
          claimedLogin: claim!.claimedLogin,
          resolvedLogin: org.githubLogin,
          githubUserId: org.githubUserId,
          organization: org.organization,
          orgOutcome: org.outcome,
          teamResource,
          teamId: team.teamId,
          teamSlug: team.teamSlug,
          teamOutcome: team.outcome,
          teamMembershipState: membership?.state,
          teamMembershipRole: membership?.role,
          teamAccessRequestState: teamRow!.status,
          teamOperationId: teamOps[0]!.id,
          provisionedAt: teamRow!.provisionedAt,
          externalIdentityCount: links.length,
          teamOperationCount: teamOps.length,
          replayed: [replayOrg.replayed, replayTeam.replayed],
          providerWrites: writes.length,
          duplicateWrites: writes.length - 1,
          workflowState: finalWorkflow.state,
        },
        null,
        2,
      ),
    );
  });
});
