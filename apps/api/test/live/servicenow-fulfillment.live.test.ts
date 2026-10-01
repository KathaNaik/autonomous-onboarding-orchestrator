// LIVE M7D test: ServiceNow-backed human fulfillment against the real PDI. Never part of
// pnpm test / test:integration. Run explicitly: `pnpm test:servicenow:fulfillment:live`.
// Prerequisites (SETUP.md §11): request_kind + fulfillment_state fields, the fulfiller role and
// ACLs, the synthetic fulfiller account (SERVICENOW_FULFILLER_USERNAME/PASSWORD in the git-ignored
// .env), SERVICENOW_CALLBACK_* and HRIS_WEBHOOK_SECRET. Otherwise LIVE_FULFILLMENT_BLOCKED.
//
// Synthetic data only: one synthetic hire whose only resource is aws-dev (policy ALLOW). After
// setup the test hands control to M7C (outbox runner + wake handler + coordinator), which
// dispatches M7D; it never calls provisionServiceNowAccess itself. The human fulfiller is the
// synthetic least-privilege fulfiller account (a test-only PATCH of fulfillment_state); the
// backend integration account never updates records. The notification is delivered in-process
// with the real record's identifiers (M4C already proved live signed delivery through a tunnel).
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
  externalOperations,
  workflowProvisioningPlans,
  type DatabaseHandle,
} from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import {
  createAccessAuthorizationService,
  createEventHandlers,
  createExternalOperationService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  noopLogger,
  type ServiceNowFulfillmentGateway,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import {
  checkAccessRequestTable,
  createServiceNowClient,
  loadServiceNowConfig,
  type ServiceNowClient,
  type ServiceNowConfig,
} from "@aoo/servicenow";
import {
  SN_CALLBACK_SIGNATURE_HEADER,
  SN_CALLBACK_TIMESTAMP_HEADER,
  hrisSignatureHeaders,
  signServiceNowCallback,
} from "@aoo/webhooks";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const RESOURCE = "aws-dev";
export const LIVE_REPORT = join(tmpdir(), "aoo-m7d-fulfillment-live-report.json");

let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;
let sn: ServiceNowConfig;
let client: ServiceNowClient;
let hrisSecret: string;
let callbackSecret: string;
let callbackInstance: string;

function blocked(reason: string): never {
  throw new Error(`LIVE_FULFILLMENT_BLOCKED: ${reason} (see servicenow-app/SETUP.md §11)`);
}

/** The human fulfiller's action (test-only): the synthetic least-privilege fulfiller account. */
async function markFulfilled(sysId: string) {
  const user = process.env.SERVICENOW_FULFILLER_USERNAME!;
  const pass = process.env.SERVICENOW_FULFILLER_PASSWORD!;
  const res = await fetch(`${sn.instanceUrl}/api/now/table/${sn.accessRequestTable}/${sysId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ fulfillment_state: "fulfilled" }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`fulfiller update failed with HTTP ${res.status}`);
}

beforeAll(async () => {
  try {
    sn = loadServiceNowConfig(process.env);
  } catch (err) {
    blocked(`ServiceNow integration config missing: ${(err as Error).message}`);
  }
  const env = process.env;
  if (!env.SERVICENOW_SCHEMA_USERNAME || !env.SERVICENOW_SCHEMA_PASSWORD) {
    blocked("SERVICENOW_SCHEMA_USERNAME/PASSWORD are needed for the read-only schema preflight");
  }
  if (!env.SERVICENOW_FULFILLER_USERNAME || !env.SERVICENOW_FULFILLER_PASSWORD) {
    blocked("SERVICENOW_FULFILLER_USERNAME/PASSWORD (the synthetic fulfiller) are not configured");
  }
  hrisSecret = env.HRIS_WEBHOOK_SECRET?.trim() ?? "";
  callbackSecret = env.SERVICENOW_CALLBACK_SECRET?.trim() ?? "";
  callbackInstance = env.SERVICENOW_CALLBACK_INSTANCE?.trim() ?? "";
  if (hrisSecret.length < 32) blocked("HRIS_WEBHOOK_SECRET is not configured");
  if (!callbackSecret || !callbackInstance || !env.SERVICENOW_CALLBACK_TABLE) {
    blocked("SERVICENOW_CALLBACK_* are not configured");
  }
  // Read-only preflight: the table must already carry the M7D fields.
  const admin = createServiceNowClient({
    ...sn,
    username: env.SERVICENOW_SCHEMA_USERNAME,
    password: env.SERVICENOW_SCHEMA_PASSWORD,
  });
  let problems: string[];
  try {
    problems = checkAccessRequestTable(await admin.describeAccessRequestTable());
  } catch (err) {
    blocked(`schema preflight failed (${(err as { code?: string }).code ?? "error"})`);
  }
  if (problems.length > 0) blocked(`table not ready: ${problems.join("; ")}`);
  client = createServiceNowClient(sn);
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

describe("M7D live: authorization → automatic ServiceNow fulfillment → authoritative read-back", () => {
  it("creates one real fulfillment record, waits for the human, verifies fulfilled, completes, replays", async () => {
    const db = handle.db;
    const catalogs = loadCatalogRegistry();
    const workflows = createWorkflowService(db);
    const runId = Date.now().toString(36);

    // Counts ServiceNow writes made by the fulfillment path (reads pass through).
    let posts = 0;
    const gateway: ServiceNowFulfillmentGateway = {
      queryAccessRequests: (...a) => client.queryAccessRequests(...a),
      getAccessRequest: (...a) => client.getAccessRequest(...a),
      createAccessRequest: (...a) => (posts++, client.createAccessRequest(...a)),
    };
    const coordinator = createProvisioningCoordinator(db, {
      catalogs,
      workflows,
      servicenow: createServiceNowFulfillmentService(db, {
        catalogs,
        externalOperations: createExternalOperationService(db, {
          handlers: [createServiceNowFulfillmentHandler(gateway)],
          reconcile: { attempts: 5, delayMs: 2000 },
        }),
        servicenow: gateway,
        correlationPrefix: "aoo-test-ful-",
        ownerId: "m7d-live-worker",
        leaseMs: 120_000,
      }),
      fulfillmentReconcileIntervalMs: 120_000,
    });
    const runner = createOutboxRunner(createPostgresOutboxStore(db), {
      workerId: "m7d-live-worker",
      batchSize: 10,
      leaseMs: 120_000,
      retry: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 5000 },
      handlers: createEventHandlers({ workflows, provisioning: coordinator }),
      logger: noopLogger,
    });
    const drain = async () => {
      for (let i = 0; i < 10; i++) if ((await runner.runOnce()).claimed === 0) return;
    };

    // 1. Synthetic hire (signed HRIS webhook) → scripted agent (aws-dev only) → policy ALLOW.
    const body = JSON.stringify({
      eventId: `evt-m7d-live-${runId}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: `TEST-EMP-M7D-${runId}`,
      employee: { firstName: "Synthetic", lastName: "M7dFixture", email: "aoo.m7d@example.com" },
      role: "Backend Software Engineer",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
      jobDescription: "SYNTHETIC M7D live fulfillment fixture. Not real data.",
      managerId: "TEST-MGR-M7D",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
    });
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
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m7d-live",
    });
    const agent = createRoleAccessAgent({
      provider: createScriptedModelProvider([outputOf(RESOURCE)]),
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
    const decided = authz.resources.find((r) => r.resourceId === RESOURCE)!;
    expect(decided).toMatchObject({ decision: "ALLOW", status: "READY_FOR_PROVISIONING" });
    const [plan] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId));

    // 2. M7C wakes and dispatches M7D: one real fulfillment record; the resource waits.
    await drain();
    const rowOf = async () =>
      (
        await db.select().from(accessRequests).where(eq(accessRequests.id, decided.accessRequestId))
      )[0]!;
    const waiting = await rowOf();
    expect(waiting).toMatchObject({ status: "PROVISIONING", providerState: "FULFILLMENT_PENDING" });
    expect(posts).toBe(1);
    const sysId = (waiting.providerEvidence as { serviceNowSysId: string }).serviceNowSysId;
    const initial = await client.getAccessRequest(sysId);
    expect(initial).toMatchObject({
      requestKind: "fulfillment",
      fulfillmentState: "pending",
      approvalState: "not_required",
      resourceId: RESOURCE,
      workflowId,
    });

    // 3. The human fulfiller did the external AWS work and marks the record fulfilled.
    await markFulfilled(sysId);

    // 4. Notification (in-process, real identifiers) → wake → authoritative GET → PROVISIONED.
    const callback = JSON.stringify({
      eventId: `${sysId}:m7d-live-${runId}`,
      instance: callbackInstance,
      table: sn.accessRequestTable,
      sysId,
      number: initial!.number,
      correlationKey: initial!.correlationKey,
      claimedFulfillmentState: "fulfilled",
    });
    const ts = String(Date.now());
    const cb = await app.inject({
      method: "POST",
      url: "/webhooks/servicenow/fulfillment",
      headers: {
        "content-type": "application/json",
        [SN_CALLBACK_TIMESTAMP_HEADER]: ts,
        [SN_CALLBACK_SIGNATURE_HEADER]: signServiceNowCallback(ts, callback, callbackSecret),
      },
      payload: callback,
    });
    expect(cb.statusCode).toBe(202);
    await drain();
    const done = await rowOf();
    expect(done).toMatchObject({ status: "PROVISIONED", providerTargetId: sysId });
    const final = await client.getAccessRequest(sysId);
    expect(final?.fulfillmentState).toBe("fulfilled");
    expect((await workflows.getWorkflow(workflowId))!.workflow.state).toBe("ONBOARDING_GENERATION");
    const [planAfter] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId));
    expect(planAfter).toMatchObject({ status: "COMPLETE" });

    // 5. Replay: coordinator + sweep + outbox again → no POST, same operation, one transition.
    const [op] = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, workflowId));
    const replay = await coordinator.coordinateProvisioning({ workflowId });
    await coordinator.enqueueDueWakes();
    await drain();
    expect(replay).toMatchObject({ outcome: "ALREADY_COMPLETE", transitioned: false });
    expect(posts).toBe(1);
    const opsAfter = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, workflowId));
    expect(opsAfter.map((o) => o.id)).toEqual([op!.id]);
    expect((await rowOf()).status).toBe("PROVISIONED");
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
    const byKey = await client.queryAccessRequests({
      correlationKey: initial!.correlationKey,
      limit: 5,
    });
    expect(byKey).toHaveLength(1);

    writeFileSync(
      LIVE_REPORT,
      JSON.stringify(
        {
          resourceId: RESOURCE,
          accessDecisionId: decided.accessDecisionId,
          accessRequestId: decided.accessRequestId,
          planId: plan!.id,
          ticketNumber: initial!.number,
          sysId,
          requestKind: initial!.requestKind,
          initialFulfillmentState: initial!.fulfillmentState,
          finalFulfillmentState: final!.fulfillmentState,
          externalOperationId: op!.id,
          externalOperationStatus: op!.status,
          serviceNowPosts: posts,
          callbackPath: "in-process signed notification → wake → authoritative GET",
          finalAccessRequestState: (await rowOf()).status,
          finalWorkflowState: (await workflows.getWorkflow(workflowId))!.workflow.state,
          planStatus: planAfter!.status,
          replay: { outcome: replay.outcome, newPosts: posts - 1, transitions: transitions.length },
          recordsForCorrelationKey: byKey.length,
          duplicateRecords: byKey.length - 1,
        },
        null,
        2,
      ),
    );
  });
});
