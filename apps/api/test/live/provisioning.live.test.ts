// LIVE M7C test: automatic, dependency-aware provisioning against the real GitHub test org.
// Never part of pnpm test / test:integration. Run explicitly: `pnpm test:provisioning:live`.
// Needs GITHUB_TOKEN, GITHUB_ORG, GITHUB_TEST_USERNAME, GITHUB_FRONTEND_TEAM_SLUG/NAME,
// ONBOARDING_ADMIN_TOKEN and HRIS_WEBHOOK_SECRET in the git-ignored .env; otherwise it fails with
// LIVE_PROVISIONING_BLOCKED before any write.
//
// Fixture (controlled, synthetic): GITHUB_TEST_USERNAME is ALREADY an active member of the org and
// NOT yet on the frontend team (github-team-frontend depends on github-org-membership). If it is
// already on that team, the test stops with LIVE_PROVISIONING_WRITE_BLOCKED (memberships are never
// removed for cleanup).
//
// After setup (signed HRIS webhook → scripted agent → policy), control is handed to M7C: the real
// outbox runner + provisioning.workflow.wake handler + ProvisioningCoordinator. The test never
// calls provisionGitHubAccess/provisionOktaAccess itself. No model call, no ServiceNow call.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessRequests,
  auditEvents,
  createDatabase,
  externalIdentities,
  externalOperations,
  workflowProvisioningPlans,
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
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubProvisioningService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createWorkflowService,
  noopLogger,
  type GitHubGateway,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import { HRIS_SIGNATURE_HEADER, signHrisPayload } from "@aoo/webhooks";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const ORG = "github-org-membership";
const TEAM = "github-team-frontend";
const OPERATOR = "m7c-live-hr";
export const LIVE_REPORT = join(tmpdir(), "aoo-m7c-provisioning-live-report.json");

let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;
let client: GitHubClient;
let targets: ReadonlyMap<string, GitHubTarget>;
let fixture: string;
let adminToken: string;
let hrisSecret: string;

function blocked(reason: string): never {
  throw new Error(`LIVE_PROVISIONING_BLOCKED: ${reason}`);
}

/** Counts every GitHub call made through the provisioning path (the coordinator makes none). */
function counting(gh: GitHubClient) {
  const writes: string[] = [];
  let reads = 0;
  const r =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A) => {
      reads++;
      return fn(...a);
    };
  const gateway: GitHubGateway = {
    getUserByLogin: r((...a: Parameters<GitHubClient["getUserByLogin"]>) =>
      gh.getUserByLogin(...a),
    ),
    getUserById: r((...a: Parameters<GitHubClient["getUserById"]>) => gh.getUserById(...a)),
    getOrganization: r((...a: Parameters<GitHubClient["getOrganization"]>) =>
      gh.getOrganization(...a),
    ),
    getOrgMembership: r((...a: Parameters<GitHubClient["getOrgMembership"]>) =>
      gh.getOrgMembership(...a),
    ),
    getTeam: r((...a: Parameters<GitHubClient["getTeam"]>) => gh.getTeam(...a)),
    getTeamMembership: r((...a: Parameters<GitHubClient["getTeamMembership"]>) =>
      gh.getTeamMembership(...a),
    ),
    setOrgMembership: (...a) => (writes.push("setOrgMembership"), gh.setOrgMembership(...a)),
    addTeamMembership: (...a) => (writes.push("addTeamMembership"), gh.addTeamMembership(...a)),
  };
  return { gateway, writes, reads: () => reads };
}

beforeAll(async () => {
  // Read-only preflight: nothing is written unless every check passes.
  let config;
  try {
    config = loadGitHubConfig(process.env);
    targets = loadGitHubTargets(process.env);
  } catch (err) {
    blocked((err as Error).message);
  }
  fixture = process.env.GITHUB_TEST_USERNAME?.trim() ?? "";
  adminToken = process.env.ONBOARDING_ADMIN_TOKEN?.trim() ?? "";
  hrisSecret = process.env.HRIS_WEBHOOK_SECRET?.trim() ?? "";
  if (!fixture) blocked("GITHUB_TEST_USERNAME is not configured");
  if (adminToken.length < 32) blocked("ONBOARDING_ADMIN_TOKEN is not configured");
  if (hrisSecret.length < 32) blocked("HRIS_WEBHOOK_SECRET is not configured");
  const org = targets.get(ORG);
  const team = targets.get(TEAM);
  if (!org) blocked("GITHUB_ORG is not configured");
  if (team?.kind !== "team") blocked("GITHUB_FRONTEND_TEAM_SLUG/NAME are not configured");
  client = createGitHubClient(config);
  try {
    await client.verifyCredentials();
  } catch (err) {
    blocked(`token or API URL rejected (${(err as { code?: string }).code ?? "error"})`);
  }
  const m = await client.getOrgMembership(org.org, fixture);
  if (m?.state !== "active" || m.role !== "member") {
    blocked("the fixture must already be an ACTIVE org member with the member role");
  }
  const t = await client.getTeam(team.org, team.teamSlug);
  if (!t || t.slug !== team.teamSlug || t.name !== team.teamName) {
    blocked("the frontend team slug/name does not match GitHub exactly");
  }
  if (await client.getTeamMembership(team.org, team.teamSlug, fixture)) {
    throw new Error(
      "LIVE_PROVISIONING_WRITE_BLOCKED: the fixture is already on the frontend team; memberships are never removed",
    );
  }
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
  app = await buildApp(
    loadConfig({ ...process.env, DATABASE_URL: testDb.url, LOG_LEVEL: "silent" }),
  );
});
afterAll(async () => {
  await app?.close();
  await handle?.close();
  await testDb?.drop();
});

describe("M7C live: authorization → automatic, dependency-aware GitHub provisioning", () => {
  it("wakes on authorization and the HR claim, provisions org then frontend team once, completes, replays", async () => {
    const db = handle.db;
    const catalogs = loadCatalogRegistry();
    const workflows = createWorkflowService(db);
    const runId = Date.now().toString(36);
    const counted = counting(client);

    // The M7C worker: existing M7B service + provider-neutral coordinator, driven by the outbox.
    const coordinator = createProvisioningCoordinator(db, {
      catalogs,
      workflows,
      github: createGitHubProvisioningService(db, {
        catalogs,
        externalOperations: createExternalOperationService(db, {
          handlers: createGitHubHandlers(counted.gateway),
          reconcile: { attempts: 5, delayMs: 2000 },
        }),
        github: counted.gateway,
        targets,
        ownerId: "m7c-live-worker",
        leaseMs: 120_000,
      }),
      reconcileIntervalMs: 300_000,
      retryDelayMs: 60_000,
    });
    const runner = createOutboxRunner(createPostgresOutboxStore(db), {
      workerId: "m7c-live-worker",
      batchSize: 10,
      leaseMs: 120_000,
      retry: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 5000 },
      handlers: createEventHandlers({ workflows, provisioning: coordinator }),
      logger: noopLogger,
    });
    const drain = async () => {
      for (let i = 0; i < 10; i++) if ((await runner.runOnce()).claimed === 0) return;
    };

    // 1. Synthetic hire through the signed HRIS webhook (no GitHub data).
    const body = JSON.stringify({
      eventId: `evt-m7c-live-${runId}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: `TEST-EMP-M7C-${runId}`,
      employee: { firstName: "Synthetic", lastName: "M7cFixture", email: "aoo.m7c@example.com" },
      role: "Frontend Software Engineer",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
      jobDescription: "SYNTHETIC M7C live provisioning fixture. Not real data.",
      managerId: "TEST-MGR-M7C",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
    });
    const intake = await app.inject({
      method: "POST",
      url: "/webhooks/hris",
      headers: {
        "content-type": "application/json",
        [HRIS_SIGNATURE_HEADER]: signHrisPayload(body, hrisSecret),
      },
      payload: body,
    });
    expect(intake.statusCode).toBe(202);
    const workflowId = intake.json().workflowId as string;

    // 2. Scripted agent (fixture resources only) → deterministic policy → READY + plan + wake.
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m7c-live",
    });
    const agent = createRoleAccessAgent({
      provider: createScriptedModelProvider([outputOf(ORG, TEAM)]),
    });
    const { agentRunId } = await createRoleAccessRecommendationService(db, {
      agent,
      catalogs,
    }).recommendAccess({ workflowId });
    const authz = await createAccessAuthorizationService(db, {
      policies: loadPolicyRegistry(catalogs),
      catalogs,
      workflows,
      externalOperations: createExternalOperationService(db, {}),
    }).authorizeAgentRun({ agentRunId });
    const initial = Object.fromEntries(authz.resources.map((r) => [r.resourceId, r.status]));
    expect(initial).toEqual({ [ORG]: "READY_FOR_PROVISIONING", [TEAM]: "READY_FOR_PROVISIONING" });
    const [plan] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId));
    expect(plan).toMatchObject({ agentRunId, status: "ACTIVE" });

    // 3. The worker wakes: no HR claim yet → org waits (claim required), team waits; 0 GitHub calls.
    await drain();
    const rowsOf = () =>
      db.select().from(accessRequests).where(eq(accessRequests.agentRunId, agentRunId));
    const blockers = async () =>
      Object.fromEntries(
        (await rowsOf()).map((r) => [r.resourceId, `${r.status}/${r.orchestrationBlocker ?? "-"}`]),
      );
    const waiting = await blockers();
    expect(waiting).toEqual({
      [ORG]: "READY_FOR_PROVISIONING/GITHUB_IDENTITY_CLAIM_REQUIRED",
      [TEAM]: "READY_FOR_PROVISIONING/DEPENDENCIES_NOT_READY",
    });
    expect(counted.reads() + counted.writes.length).toBe(0);

    // 4. HR records the username through the real admin endpoint: the claim's wake resumes M7C.
    const claim = await app.inject({
      method: "POST",
      url: `/admin/onboarding/${workflowId}/github-identity`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
        "x-operator-id": OPERATOR,
      },
      payload: JSON.stringify({ githubLogin: fixture }),
    });
    expect(claim.statusCode).toBe(200);
    await drain();

    // 5. Org satisfied without a write; frontend team written exactly once; read back; complete.
    const final = await blockers();
    expect(final).toEqual({ [ORG]: "PROVISIONED/-", [TEAM]: "PROVISIONED/-" });
    expect(counted.writes).toEqual(["addTeamMembership"]);
    const team = targets.get(TEAM) as Extract<GitHubTarget, { kind: "team" }>;
    const membership = await client.getTeamMembership(team.org, team.teamSlug, fixture);
    expect(membership).toMatchObject({ state: "active", role: "member" });
    expect((await workflows.getWorkflow(workflowId))!.workflow.state).toBe("ONBOARDING_GENERATION");
    const dispatched = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "provisioning.request_dispatched"),
        ),
      )
      .orderBy(auditEvents.occurredAt);
    const dispatchOrder = dispatched.map((a) => a.payload.resourceId as string);
    expect(dispatchOrder.indexOf(ORG)).toBeLessThan(dispatchOrder.lastIndexOf(TEAM));

    // 6. Replay: coordinator + outbox + reconciliation sweep again → nothing new anywhere.
    const opsBefore = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, workflowId));
    const linksBefore = await db.select().from(externalIdentities);
    const callsBefore = counted.reads() + counted.writes.length;
    const replay = await coordinator.coordinateProvisioning({ workflowId });
    await coordinator.enqueueDueWakes();
    await drain();
    expect(replay).toMatchObject({ outcome: "ALREADY_COMPLETE", transitioned: false });
    expect(counted.reads() + counted.writes.length).toBe(callsBefore);
    expect(
      await db
        .select()
        .from(externalOperations)
        .where(eq(externalOperations.workflowId, workflowId)),
    ).toEqual(opsBefore);
    expect(await db.select().from(externalIdentities)).toEqual(linksBefore);
    const [planAfter] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId));
    expect(planAfter).toMatchObject({ status: "COMPLETE" });
    const transitions = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "workflow.transitioned"),
          eq(auditEvents.toState, "ONBOARDING_GENERATION"),
        ),
      );
    expect(transitions).toHaveLength(1);
    const githubOps = opsBefore.filter((o) => o.provider === "github");

    writeFileSync(
      LIVE_REPORT,
      JSON.stringify(
        {
          planId: plan!.id,
          agentRunId,
          catalog: `${plan!.catalogVersion} ${plan!.catalogHash}`,
          policy: `${plan!.policyVersion} ${plan!.policyHash}`,
          initialStates: initial,
          blockersBeforeClaim: waiting,
          dispatchOrder,
          githubReads: callsBefore - counted.writes.length,
          githubWrites: counted.writes,
          teamMembership: membership && { state: membership.state, role: membership.role },
          finalStates: final,
          workflowState: (await workflows.getWorkflow(workflowId))!.workflow.state,
          planStatus: planAfter!.status,
          githubOperations: githubOps.map((o) => `${o.operationType}:${o.status}`),
          externalIdentityLinks: linksBefore.length,
          replay: {
            outcome: replay.outcome,
            newGitHubCalls: counted.reads() + counted.writes.length - callsBefore,
            transitions: transitions.length,
          },
          duplicateWrites: counted.writes.length - 1,
        },
        null,
        2,
      ),
    );
  });
});
