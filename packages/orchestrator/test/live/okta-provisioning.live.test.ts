// LIVE M7A test against a real Okta sandbox. Never part of pnpm test / test:integration.
// Run explicitly: `pnpm test:okta:live`. Needs OKTA_BASE_URL, OKTA_API_TOKEN,
// OKTA_ENGINEERING_GROUP_ID and OKTA_ENGINEERING_GROUP_NAME (the dedicated test group's exact
// name) in the git-ignored .env; otherwise it fails with LIVE_OKTA_BLOCKED before any write.
//
// Synthetic data only: one deterministic fixture identity (TEST-EMP-M7A-OKTA-FIXTURE /
// aoo.m7a.fixture@example.com), created STAGED (no activation email) on the first run and reused
// afterwards. Nothing is deleted (no delete or remove-membership permission is used or needed).
// No model call (scripted agent) and no ServiceNow call (the resource is policy-ALLOWed).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessRequests,
  createDatabase,
  externalIdentities,
  externalOperations,
  type DatabaseHandle,
} from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import {
  createOktaClient,
  loadOktaConfig,
  loadOktaGroupTargets,
  type OktaClient,
  type OktaGroupTarget,
} from "@aoo/okta";
import { loadPolicyRegistry } from "@aoo/policy";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAccessAuthorizationService,
  createExternalOperationService,
  createHrisIntakeService,
  createOktaHandlers,
  createOktaProvisioningService,
  createRoleAccessRecommendationService,
  createWorkflowService,
} from "../../src/index.js";

const FIXTURE = {
  employeeId: "TEST-EMP-M7A-OKTA-FIXTURE",
  email: "aoo.m7a.fixture@example.com",
  firstName: "Synthetic",
  lastName: "M7aFixture",
};
const RESOURCE = "okta-engineering-group";
export const LIVE_REPORT = join(tmpdir(), "aoo-m7a-okta-live-report.json");

let testDb: TestDatabase;
let handle: DatabaseHandle;
let client: OktaClient;
let target: OktaGroupTarget;

function blocked(reason: string): never {
  throw new Error(`LIVE_OKTA_BLOCKED: ${reason}`);
}

beforeAll(async () => {
  // Read-only preflight: no write happens unless every check passes.
  let config;
  try {
    config = loadOktaConfig(process.env);
  } catch (err) {
    blocked((err as Error).message);
  }
  const targets = loadOktaGroupTargets(process.env);
  const configured = targets.get(RESOURCE);
  if (!configured) blocked("OKTA_ENGINEERING_GROUP_ID is not configured");
  if (!configured.expectedName) {
    blocked("OKTA_ENGINEERING_GROUP_NAME must name the dedicated test group exactly");
  }
  target = configured;
  client = createOktaClient(config);
  try {
    await client.verifyCredentials();
  } catch (err) {
    blocked(`credentials or base URL rejected (${(err as { code?: string }).code ?? "error"})`);
  }
  const group = await client.getGroup(target.groupId);
  if (!group) blocked("the configured group does not exist");
  if (group.type === "BUILT_IN") blocked("the configured group is a built-in group");
  if (group.profile.name !== target.expectedName) {
    blocked("the configured group's name does not match OKTA_ENGINEERING_GROUP_NAME");
  }
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
});
afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

describe("M7A live: authorized Okta resource → real Okta identity and group membership", () => {
  it("provisions, verifies by read-back and replays without duplicates", async () => {
    const db = handle.db;
    const catalogs = loadCatalogRegistry();
    const policies = loadPolicyRegistry(catalogs);
    const workflows = createWorkflowService(db);
    const before = await client.findUsersByExactIdentity({
      login: FIXTURE.email,
      employeeNumber: FIXTURE.employeeId,
    });
    expect(before.length).toBeLessThanOrEqual(1);
    const fixtureExisted = before.length === 1;

    // 1. Synthetic hire → agent run (scripted) → policy authorization (ALLOW).
    const runId = `${Date.now().toString(36)}`;
    const { workflowId } = await createHrisIntakeService(db).acceptOfferSigned({
      eventId: `evt-m7a-live-${runId}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: FIXTURE.employeeId,
      employee: { firstName: FIXTURE.firstName, lastName: FIXTURE.lastName, email: FIXTURE.email },
      role: "Backend Software Engineer",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
      jobDescription: "SYNTHETIC M7A live Okta fixture. Not real data.",
      managerId: "TEST-MGR-M7A",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
    });
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m7a-live",
    });
    const agent = createRoleAccessAgent({
      provider: createScriptedModelProvider([outputOf(RESOURCE)]),
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
    const decided = authz.resources.find((r) => r.resourceId === RESOURCE)!;
    expect(decided).toMatchObject({
      decision: "ALLOW",
      matchedRuleId: "engineering-baseline",
      status: "READY_FOR_PROVISIONING",
    });

    // 2. Provision through the durable layer with the real Okta client.
    const extOps = createExternalOperationService(db, {
      handlers: createOktaHandlers(client),
      reconcile: { attempts: 5, delayMs: 2000 },
    });
    const service = createOktaProvisioningService(db, {
      catalogs,
      externalOperations: extOps,
      okta: client,
      targets: new Map([[RESOURCE, target]]),
      ownerId: "m7a-live",
      leaseMs: 120_000,
    });
    const result = await service.provisionOktaAccess({ accessRequestId: decided.accessRequestId });
    expect(result).toMatchObject({
      status: "PROVISIONED",
      replayed: false,
      oktaGroupId: target.groupId,
    });

    // 3. Authoritative read-back from Okta.
    const user = await client.getUser(result.oktaUserId);
    expect(user?.profile).toMatchObject({
      login: FIXTURE.email,
      employeeNumber: FIXTURE.employeeId,
    });
    expect(await client.isUserInGroup(result.oktaUserId, target.groupId)).toBe(true);
    const [row] = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, decided.accessRequestId));
    expect(row).toMatchObject({
      status: "PROVISIONED",
      providerSubjectId: result.oktaUserId,
      providerTargetId: target.groupId,
    });

    // 4. Replay: no provider writes, no duplicate user, no duplicate operation.
    const replay = await service.provisionOktaAccess({ accessRequestId: decided.accessRequestId });
    expect(replay).toMatchObject({ replayed: true, oktaUserId: result.oktaUserId });
    const after = await client.findUsersByExactIdentity({
      login: FIXTURE.email,
      employeeNumber: FIXTURE.employeeId,
    });
    expect(after.map((u) => u.id)).toEqual([result.oktaUserId]);
    const membershipOps = await db
      .select()
      .from(externalOperations)
      .where(
        and(
          eq(externalOperations.workflowId, workflowId),
          eq(externalOperations.operationType, "okta.add_group_membership"),
        ),
      );
    const identityOps = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.operationType, "okta.ensure_user"));
    const links = await db.select().from(externalIdentities);
    expect([membershipOps.length, identityOps.length, links.length]).toEqual([1, 1, 1]);

    writeFileSync(
      LIVE_REPORT,
      JSON.stringify(
        {
          fixture: fixtureExisted ? "reused" : "created",
          identity: result.identity,
          membership: result.membership,
          oktaUserId: result.oktaUserId,
          oktaGroupId: target.groupId,
          userStatus: user?.status,
          replayed: replay.replayed,
          oktaUsersForFixture: after.length,
          membershipOperations: membershipOps.length,
          identityOperations: identityOps.length,
          identityVia: identityOps[0]?.status,
        },
        null,
        2,
      ),
    );
  });
});
