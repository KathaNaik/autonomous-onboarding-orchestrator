// LIVE end-to-end approval test against the real ServiceNow PDI. Never part of pnpm test /
// test:integration. Prerequisites: SETUP.md §10 (column, private properties, business rule) and a
// public tunnel to APPROVAL_LIVE_PORT whose URL is in aoo.approval_callback.url.
// Synthetic data only. The human approver is simulated through the schema-verifier (admin)
// account, the only place outside schema verification that uses it.
import { createDatabase, approvalCallbackEvents, approvals, type DatabaseHandle } from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import {
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
} from "@aoo/orchestrator";
import {
  createServiceNowClient,
  loadServiceNowConfig,
  type ServiceNowConfig,
} from "@aoo/servicenow";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const PORT = Number(process.env.APPROVAL_LIVE_PORT ?? 4810);
let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;
let sn: ServiceNowConfig;
const captured: Array<{ body: string; headers: Record<string, string> }> = [];

function blocked(reason: string): never {
  throw new Error(`BLOCKED: ${reason} (see packages/servicenow/servicenow-app/SETUP.md §10)`);
}

/** Test-only approver action: the adapter itself has no update capability. */
async function setApprovalAsApprover(sysId: string, state: "approved" | "rejected") {
  const user = process.env.SERVICENOW_SCHEMA_USERNAME;
  const pass = process.env.SERVICENOW_SCHEMA_PASSWORD;
  if (!user || !pass) blocked("SERVICENOW_SCHEMA_USERNAME/PASSWORD needed to act as the approver");
  const res = await fetch(`${sn.instanceUrl}/api/now/table/${sn.accessRequestTable}/${sysId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ approval_state: state }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`approver update failed with HTTP ${res.status}`);
}

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  try {
    sn = loadServiceNowConfig(process.env);
  } catch (err) {
    blocked(`ServiceNow integration config missing: ${(err as Error).message}`);
  }
  if (!process.env.SERVICENOW_CALLBACK_SECRET) blocked("SERVICENOW_CALLBACK_SECRET not set");
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: testDb.url,
    LOG_LEVEL: "warn",
    HRIS_WEBHOOK_SECRET:
      process.env.HRIS_WEBHOOK_SECRET ?? "live-test-hris-secret-not-used-0123456789",
  });
  app = await buildApp(config);
  // Capture the exact bytes ServiceNow sent, to replay them later.
  app.addHook("preHandler", async (req) => {
    if (req.url === "/webhooks/servicenow/approvals" && Buffer.isBuffer(req.body)) {
      captured.push({
        body: req.body.toString("utf8"),
        headers: {
          "content-type": String(req.headers["content-type"]),
          "x-aoo-timestamp": String(req.headers["x-aoo-timestamp"]),
          "x-aoo-signature": String(req.headers["x-aoo-signature"]),
        },
      });
    }
  });
  await app.listen({ host: "127.0.0.1", port: PORT });
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
  await testDb?.drop();
});

describe("ServiceNow approval callback (live, synthetic)", () => {
  it("real approval in ServiceNow → signed callback → read-back → verified decision → workflow resumed once", async () => {
    const client = createServiceNowClient(sn); // integration account
    const workflows = createWorkflowService(handle.db);
    const ops = createExternalOperationService(handle.db, {
      servicenow: client,
      correlationPrefix: "aoo-test-oar-",
    });
    const approvalsSvc = createApprovalService(handle.db, { servicenow: client, workflows });

    // 1. Synthetic workflow waiting for approval, and one approval-required ticket.
    let wf = await workflows.createWorkflow({
      employee: {
        hrisEmployeeId: `TEST-EMP-M4C-LIVE-${Date.now()}`,
        email: "synthetic.m4c@example.com",
        firstName: "Synthetic",
        lastName: "M4C",
      },
      actor: "m4c-live-test",
    });
    for (const to of ["ACCESS_PLANNING", "POLICY_REVIEW", "AWAITING_APPROVAL"] as const) {
      wf = await workflows.transition({
        workflowId: wf.id,
        to,
        expectedVersion: wf.version,
        actor: "m4c-live-test",
      });
    }
    const { operation } = await ops.requestServiceNowAccessRequest({
      workflowId: wf.id,
      employeeId: "TEST-EMP-M4C-LIVE",
      resourceId: `test:resource:m4c-live:${Date.now()}`,
      requestedEntitlement: "synthetic-member",
      agentReason: "SYNTHETIC M4C live approval test. Not real data.",
      policyDecision: "requires_approval",
      shortDescription: "SYNTHETIC TEST RECORD – M4C approval",
      actor: "m4c-live-test",
    });
    const ticket = await ops.execute(operation.id, { ownerId: "m4c-live", leaseMs: 60_000 });
    const created = await client.getAccessRequest(ticket.externalId);
    expect(created).toMatchObject({
      approvalState: "pending",
      policyDecision: "requires_approval",
    });
    console.info(
      `[live] ticket ${ticket.externalReference} (${ticket.externalId}) awaiting approval`,
    );

    // 2. The approver approves in ServiceNow; the business rule sends the real signed callback.
    await setApprovalAsApprover(ticket.externalId, "approved");
    const cb = await waitFor(
      async () =>
        (
          await handle.db
            .select()
            .from(approvalCallbackEvents)
            .where(eq(approvalCallbackEvents.correlationKey, operation.correlationKey))
        )[0],
      120_000,
      "the ServiceNow callback to arrive through the tunnel",
    );
    console.info(`[live] callback ${cb.eventId} received (claimed ${cb.claimedState})`);

    // 3. The worker verifies against ServiceNow and applies the decision.
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "m4c-live-worker",
      batchSize: 10,
      leaseMs: 60_000,
      retry: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 5000 },
      handlers: createEventHandlers({ workflows, approvals: approvalsSvc }),
    });
    await waitFor(
      async () => ((await runner.runOnce()).succeeded > 0 ? true : undefined),
      60_000,
      "verification",
    );

    const [approval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.externalOperationId, operation.id));
    expect(approval).toMatchObject({
      status: "APPROVED",
      providerState: "approved",
      decidedByEventId: cb.eventId,
      externalId: ticket.externalId,
    });
    const [processed] = await handle.db
      .select()
      .from(approvalCallbackEvents)
      .where(eq(approvalCallbackEvents.id, cb.id));
    expect(processed).toMatchObject({ status: "PROCESSED", outcome: "APPLIED_APPROVED" });
    expect((await workflows.getWorkflow(wf.id))!.workflow.state).toBe("PROVISIONING");
    const resumes = () =>
      workflows.listAuditEvents(wf.id).then((a) => a.filter((e) => e.toState === "PROVISIONING"));
    expect(await resumes()).toHaveLength(1);
    console.info(`[live] approval verified by read-back; workflow ${wf.id} → PROVISIONING`);

    // 4. Replay the exact captured ServiceNow request: accepted as a duplicate, no new transition.
    expect(captured.length).toBeGreaterThan(0);
    const replay = await fetch(`http://127.0.0.1:${PORT}/webhooks/servicenow/approvals`, {
      method: "POST",
      headers: captured[0]!.headers,
      body: captured[0]!.body,
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    await runner.runOnce();
    expect(await resumes()).toHaveLength(1);
    expect(await approvalsSvc.processCallback(cb.id)).toMatchObject({
      alreadyProcessed: true,
      outcome: "APPLIED_APPROVED",
    });
    expect(await resumes()).toHaveLength(1);
  });
});
