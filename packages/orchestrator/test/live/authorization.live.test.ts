// LIVE M6B test against the real ServiceNow PDI. Never part of pnpm test / test:integration.
// Run explicitly: `pnpm test:m6b:live`. Synthetic data only (employee TEST-EMP-M6B-LIVE-*,
// correlation prefix aoo-test-oar-). Records are never deleted (no delete permission).
//
// Scope: recommendation → policy → per-resource state → real ServiceNow ticket (M4B path) → real
// approval by a test-only approver → authoritative read-back (M4C path) → per-resource effect.
// The signed callback is recorded in-process with the real ticket's identifiers instead of
// arriving through a public tunnel: callback transport and HMAC were verified live in M4C, and the
// decision is taken only from the authoritative ServiceNow read-back either way.
// No model is called: the agent run uses the scripted test provider.
import { randomUUID } from "node:crypto";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  createDatabase,
  externalOperations,
  type DatabaseHandle,
} from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import { loadPolicyRegistry } from "@aoo/policy";
import {
  createServiceNowClient,
  loadServiceNowConfig,
  type ServiceNowClient,
  type ServiceNowConfig,
} from "@aoo/servicenow";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAccessAuthorizationService,
  createApprovalService,
  createExternalOperationService,
  createHrisIntakeService,
  createRoleAccessRecommendationService,
  createWorkflowService,
  type ServiceNowAccessRequestGateway,
} from "../../src/index.js";

const PREFIX = "aoo-test-oar-";
let testDb: TestDatabase;
let handle: DatabaseHandle;
let config: ServiceNowConfig;
let client: ServiceNowClient;

function blocked(reason: string): never {
  throw new Error(`BLOCKED: ${reason}`);
}

function counting(inner: ServiceNowClient) {
  const calls = { posts: 0 };
  const gateway: ServiceNowAccessRequestGateway = {
    queryAccessRequests: (q, o) => inner.queryAccessRequests(q, o),
    getAccessRequest: (id, o) => inner.getAccessRequest(id, o),
    createAccessRequest: (i, o) => (calls.posts++, inner.createAccessRequest(i, o)),
  };
  return { gateway, calls };
}

/** Test-only approver action (schema-verifier account); the adapter has no update capability. */
async function setApprovalAsApprover(sysId: string, state: "approved" | "rejected") {
  const user = process.env.SERVICENOW_SCHEMA_USERNAME;
  const pass = process.env.SERVICENOW_SCHEMA_PASSWORD;
  if (!user || !pass) blocked("SERVICENOW_SCHEMA_USERNAME/PASSWORD needed to act as the approver");
  const res = await fetch(
    `${config.instanceUrl}/api/now/table/${config.accessRequestTable}/${sysId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ approval_state: state }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`approver update failed with HTTP ${res.status}`);
}

beforeAll(async () => {
  try {
    config = loadServiceNowConfig(process.env); // integration account only
  } catch (err) {
    blocked(`ServiceNow live test is not configured. ${(err as Error).message}`);
  }
  if (!process.env.SERVICENOW_SCHEMA_USERNAME || !process.env.SERVICENOW_SCHEMA_PASSWORD) {
    blocked("SERVICENOW_SCHEMA_USERNAME/PASSWORD needed to act as the approver");
  }
  client = createServiceNowClient(config);
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
});
afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

describe("M6B live: recommendation → policy → ServiceNow approval → per-resource state", () => {
  it("authorizes ALLOW/DENY/REQUIRES_APPROVAL independently and applies the real approval", async () => {
    const runId = `${new Date().toISOString().slice(0, 19)}-${randomUUID().slice(0, 8)}`;
    const db = handle.db;
    const catalogs = loadCatalogRegistry();
    const policies = loadPolicyRegistry(catalogs);
    const workflows = createWorkflowService(db);
    const { gateway, calls } = counting(client);
    const extOps = createExternalOperationService(db, {
      servicenow: gateway,
      correlationPrefix: PREFIX,
      reconcile: { attempts: 3, delayMs: 1500 },
    });
    const authz = createAccessAuthorizationService(db, {
      policies,
      catalogs,
      workflows,
      externalOperations: extOps,
    });
    const approvalSvc = createApprovalService(db, { servicenow: client, workflows });

    // Synthetic engineering contractor through the real HRIS intake path.
    const { workflowId } = await createHrisIntakeService(db).acceptOfferSigned({
      eventId: `evt-m6b-live-${runId}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: `TEST-EMP-M6B-LIVE-${runId}`,
      employee: { firstName: "Synthetic", lastName: "M6B", email: "synthetic.m6b@example.com" },
      role: "Frontend Engineer (Contract)",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "CONTRACTOR",
      jobDescription: "SYNTHETIC M6B live test hire. Not real data.",
      managerId: "TEST-MGR-M6B",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
    });
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m6b-live",
    });

    // A completed agent run (scripted provider: no model call).
    const provider = createScriptedModelProvider([
      outputOf("github-org-membership", "aws-prod", "cursor-license"),
    ]);
    const recommender = createRoleAccessRecommendationService(db, {
      agent: createRoleAccessAgent({ provider }),
      catalogs,
    });
    const { agentRunId } = await recommender.recommendAccess({ workflowId });

    // 1. Authorization: three independent decisions.
    const result = await authz.authorizeAgentRun({ agentRunId });
    const byId = Object.fromEntries(result.resources.map((r) => [r.resourceId, r]));
    expect(result).toMatchObject({
      policyVersion: "1.1.0",
      complete: true,
      summary: { total: 3, allowed: 1, denied: 1, requiresApproval: 1, failed: 0 },
      workflowState: "AWAITING_APPROVAL",
    });
    expect(byId["github-org-membership"]).toMatchObject({
      decision: "ALLOW",
      status: "READY_FOR_PROVISIONING",
    });
    expect(byId["aws-prod"]).toMatchObject({ decision: "DENY", status: "DENIED" });
    expect(byId["cursor-license"]).toMatchObject({
      decision: "REQUIRES_APPROVAL",
      status: "AWAITING_APPROVAL",
    });
    const opId = byId["cursor-license"]!.externalOperationId!;

    // 2. Only the approval-required resource creates a (real) ServiceNow ticket.
    const created = await extOps.execute(opId, { ownerId: "m6b-live", leaseMs: 60_000 });
    expect(created.via).toBe("created");
    expect(calls.posts).toBe(1);
    const [op] = await db.select().from(externalOperations).where(eq(externalOperations.id, opId));
    const ticket = await client.getAccessRequest(created.externalId);
    expect(ticket).toMatchObject({
      number: created.externalReference,
      correlationKey: op!.correlationKey,
      workflowId,
      resourceId: "cursor-license",
      policyDecision: "requires_approval",
      approvalState: "pending",
    });
    expect(ticket!.shortDescription).toContain(byId["cursor-license"]!.accessDecisionId);
    console.log(`M6B live ticket: ${created.externalReference} sys_id=${created.externalId}`);

    // 3. Repeating orchestration and execution creates no duplicate ticket.
    const again = await authz.authorizeAgentRun({ agentRunId });
    expect(again.replayed).toBe(true);
    expect((await extOps.execute(opId, { ownerId: "m6b-live", leaseMs: 60_000 })).via).toBe(
      "already_succeeded",
    );
    expect(calls.posts).toBe(1);
    expect(await client.queryAccessRequests({ correlationKey: op!.correlationKey })).toHaveLength(
      1,
    );
    expect(
      await db.select().from(accessDecisions).where(eq(accessDecisions.agentRunId, agentRunId)),
    ).toHaveLength(3);

    // 4. A (test-only) human approves in ServiceNow; the callback is verified by read-back.
    const before = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.agentRunId, agentRunId));
    await setApprovalAsApprover(created.externalId, "approved");
    const callback = {
      eventId: `${created.externalId}:m6b-live-${runId}`,
      instance: new URL(config.instanceUrl).hostname.split(".")[0]!,
      table: config.accessRequestTable,
      sysId: created.externalId,
      number: created.externalReference,
      correlationKey: op!.correlationKey,
      claimedApprovalState: "approved",
    };
    const recorded = await approvalSvc.recordServiceNowCallback(callback);
    const processed = await approvalSvc.processCallback(recorded.callbackEventId);
    expect(processed).toMatchObject({
      outcome: "APPLIED_APPROVED",
      approvalStatus: "APPROVED",
      workflowResumed: true,
    });

    const after = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.agentRunId, agentRunId));
    const rows = Object.fromEntries(after.map((r) => [r.resourceId, r]));
    expect(rows["cursor-license"]).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      authorizedVia: "APPROVAL",
    });
    for (const unchanged of ["github-org-membership", "aws-prod"]) {
      const was = before.find((r) => r.resourceId === unchanged)!;
      expect([rows[unchanged]!.status, rows[unchanged]!.version]).toEqual([
        was.status,
        was.version,
      ]);
    }
    expect((await workflows.getWorkflow(workflowId))!.workflow.state).toBe("PROVISIONING");

    // 5. Replaying the callback changes nothing.
    const replay = await approvalSvc.recordServiceNowCallback(callback);
    expect(replay.duplicate).toBe(true);
    expect(await approvalSvc.processCallback(replay.callbackEventId)).toMatchObject({
      alreadyProcessed: true,
    });
    const newEvent = await approvalSvc.recordServiceNowCallback({
      ...callback,
      eventId: `${callback.eventId}-2`,
    });
    expect(await approvalSvc.processCallback(newEvent.callbackEventId)).toMatchObject({
      outcome: "ALREADY_APPLIED",
    });
    const final = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.agentRunId, agentRunId));
    expect(final.find((r) => r.resourceId === "cursor-license")!.version).toBe(
      rows["cursor-license"]!.version,
    );
    const transitions = (await workflows.listAuditEvents(workflowId)).filter(
      (e) => e.eventType === "workflow.transitioned" && e.toState === "PROVISIONING",
    );
    expect(transitions).toHaveLength(1);
    expect(provider.calls).toHaveLength(1); // the M6A run only; M6B made no model call
  });
});
