// LIVE WRITE test against the real ServiceNow PDI. Never part of pnpm test / test:integration.
// Run explicitly: `pnpm test:servicenow:live`. Creates SYNTHETIC records only (prefix
// aoo-test-oar-, employee TEST-EMP-M4B-LIVE) and never deletes them (no delete permission).
import { randomUUID } from "node:crypto";
import { createDatabase, externalOperations, type DatabaseHandle } from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import {
  createServiceNowClient,
  loadServiceNowConfig,
  type ServiceNowClient,
  type ServiceNowConfig,
} from "@aoo/servicenow";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExternalOperationError,
  createExternalOperationService,
  createWorkflowService,
  type ServiceNowAccessRequestGateway,
} from "../../src/index.js";

const PREFIX = "aoo-test-oar-";
let testDb: TestDatabase;
let handle: DatabaseHandle;
let config: ServiceNowConfig;
let client: ServiceNowClient;

/** Counts real provider calls so the test can prove which attempts POSTed. */
function counting(inner: ServiceNowClient) {
  const calls = { posts: 0, queries: 0 };
  const gateway: ServiceNowAccessRequestGateway = {
    queryAccessRequests: (q, o) => (calls.queries++, inner.queryAccessRequests(q, o)),
    getAccessRequest: (id, o) => inner.getAccessRequest(id, o),
    createAccessRequest: (i, o) => (calls.posts++, inner.createAccessRequest(i, o)),
  };
  return { gateway, calls };
}

beforeAll(async () => {
  try {
    config = loadServiceNowConfig(process.env); // integration account only
  } catch (err) {
    throw new Error(
      `BLOCKED: ServiceNow live write test is not configured. ${(err as Error).message}`,
    );
  }
  client = createServiceNowClient(config);
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
});
afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

async function syntheticRequest(
  service: ReturnType<typeof createExternalOperationService>,
  label: string,
) {
  const runId = `${new Date().toISOString().slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const workflow = await createWorkflowService(handle.db).createWorkflow({
    employee: {
      hrisEmployeeId: `TEST-EMP-M4B-LIVE-${runId}`,
      email: "synthetic.m4b@example.com",
      firstName: "Synthetic",
      lastName: "M4B",
    },
    actor: "m4b-live-test",
  });
  const { operation } = await service.requestServiceNowAccessRequest({
    workflowId: workflow.id,
    employeeId: "TEST-EMP-M4B-LIVE",
    resourceId: `test:resource:m4b-live:${label}:${runId}`,
    requestedEntitlement: "synthetic-member",
    agentReason: "SYNTHETIC M4B live test record. Not real data.",
    policyDecision: "pending",
    shortDescription: `SYNTHETIC TEST RECORD – M4B ${label}`,
    actor: "m4b-live-test",
  });
  return operation;
}

describe("ServiceNow PDI live write (synthetic)", () => {
  it("creates one ticket, verifies it by read-back, and never duplicates it", async () => {
    const { gateway, calls } = counting(client);
    const service = createExternalOperationService(handle.db, {
      servicenow: gateway,
      correlationPrefix: PREFIX,
    });
    const operation = await syntheticRequest(service, "idempotency");
    expect(operation.correlationKey.startsWith(PREFIX)).toBe(true);

    // 1. First execution creates the record (after checking the provider has none).
    const first = await service.execute(operation.id, { ownerId: "live-1", leaseMs: 60_000 });
    expect(first).toMatchObject({ status: "SUCCEEDED", via: "created" });
    expect(calls.posts).toBe(1);

    const readBack = await client.getAccessRequest(first.externalId);
    expect(readBack).toMatchObject({
      sysId: first.externalId,
      number: first.externalReference,
      correlationKey: operation.correlationKey,
      employeeId: "TEST-EMP-M4B-LIVE",
      policyDecision: "pending",
    });
    console.info(
      `[live] created ${first.externalReference} (sys_id ${first.externalId}) key ${operation.correlationKey}`,
    );

    // 2. Same logical operation again: answered locally, no provider call.
    await expect(
      service.execute(operation.id, { ownerId: "live-2", leaseMs: 60_000 }),
    ).resolves.toMatchObject({
      via: "already_succeeded",
      externalId: first.externalId,
    });
    const again = await service.requestServiceNowAccessRequest({
      workflowId: operation.workflowId,
      employeeId: "TEST-EMP-M4B-LIVE",
      resourceId: (operation.request as { resourceId: string }).resourceId,
      requestedEntitlement: "synthetic-member",
      agentReason: "SYNTHETIC M4B live test record. Not real data.",
      policyDecision: "pending",
      shortDescription: "SYNTHETIC TEST RECORD – M4B idempotency",
      actor: "m4b-live-test",
    });
    expect(again).toMatchObject({ created: false, operation: { id: operation.id } });

    // 3. Simulate a crash after the POST but before local persistence: local state forgets the
    //    ticket. The next execution must reconcile from ServiceNow instead of POSTing again.
    await handle.db
      .update(externalOperations)
      .set({
        status: "OUTCOME_UNKNOWN",
        externalId: null,
        externalReference: null,
        completedAt: null,
      })
      .where(eq(externalOperations.id, operation.id));
    const reconciled = await service.execute(operation.id, { ownerId: "live-3", leaseMs: 60_000 });
    expect(reconciled).toMatchObject({
      via: "reconciled_after_unknown",
      externalId: first.externalId,
    });
    expect(calls.posts).toBe(1);

    // 4. Exactly one ServiceNow record carries this correlation key.
    const matches = await client.queryAccessRequests({
      correlationKey: operation.correlationKey,
      limit: 10,
    });
    expect(matches.map((m) => m.sysId)).toEqual([first.externalId]);
  });

  it("two concurrent executions of one logical operation create exactly one ticket", async () => {
    const a = counting(client);
    const b = counting(createServiceNowClient(config));
    const other = createDatabase(testDb.url);
    try {
      const serviceA = createExternalOperationService(handle.db, {
        servicenow: a.gateway,
        correlationPrefix: PREFIX,
      });
      const serviceB = createExternalOperationService(other.db, {
        servicenow: b.gateway,
        correlationPrefix: PREFIX,
      });
      const operation = await syntheticRequest(serviceA, "concurrency");

      const results = await Promise.allSettled([
        serviceA.execute(operation.id, { ownerId: "live-a", leaseMs: 60_000 }),
        serviceB.execute(operation.id, { ownerId: "live-b", leaseMs: 60_000 }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const busy = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(
        busy.every((r) => (r as PromiseRejectedResult).reason instanceof ExternalOperationError),
      ).toBe(true);
      expect(a.calls.posts + b.calls.posts).toBe(1);

      const matches = await client.queryAccessRequests({
        correlationKey: operation.correlationKey,
        limit: 10,
      });
      expect(matches).toHaveLength(1);
      console.info(
        `[live] concurrent run created ${matches[0]!.number}; other executor: ${(busy[0] as PromiseRejectedResult | undefined)?.reason?.code ?? "n/a"}`,
      );
    } finally {
      await other.close();
    }
  });
});
