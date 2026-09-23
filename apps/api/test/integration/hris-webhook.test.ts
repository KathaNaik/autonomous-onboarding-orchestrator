import {
  auditEvents,
  createDatabase,
  employees,
  hrisEventReceipts,
  onboardingWorkflows,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import { createWorkflowService } from "@aoo/orchestrator";
import { HrisOfferSignedAcceptedPayloadSchema, OUTBOX_EVENT_TYPES } from "@aoo/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { offerSignedEvent, signedRequest, testConfig } from "../helpers.js";

let app: FastifyInstance;
let handle: DatabaseHandle;

beforeAll(async () => {
  app = await buildApp(testConfig({ DATABASE_URL: inject("databaseUrl") }));
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

type Event = ReturnType<typeof offerSignedEvent>;

const deliver = (target: FastifyInstance, event: unknown, secret?: string) => {
  const req = signedRequest(event, secret);
  return target.inject({
    method: "POST",
    url: "/webhooks/hris",
    payload: req.body,
    headers: req.headers,
  });
};

/** Everything persisted for one HRIS event / employee. */
async function persisted(event: Event) {
  const db = handle.db;
  const receipts = await db
    .select()
    .from(hrisEventReceipts)
    .where(eq(hrisEventReceipts.eventId, event.eventId));
  const [employee] = await db
    .select()
    .from(employees)
    .where(eq(employees.hrisEmployeeId, event.employeeId));
  const workflows = employee
    ? await db
        .select()
        .from(onboardingWorkflows)
        .where(eq(onboardingWorkflows.employeeId, employee.id))
    : [];
  const outbox = await db
    .select()
    .from(outboxEvents)
    .where(sql`${outboxEvents.payload}->>'hrisEventId' = ${event.eventId}`);
  return { receipts, employee, workflows, outbox };
}

async function expectNothingPersisted(event: Event) {
  const p = await persisted(event);
  expect(p.receipts).toHaveLength(0);
  expect(p.employee).toBeUndefined();
  expect(p.workflows).toHaveLength(0);
  expect(p.outbox).toHaveLength(0);
}

describe("valid event", () => {
  it("returns 202 after committing receipt, employee, workflow, audit and outbox event", async () => {
    const event = offerSignedEvent();
    const res = await deliver(app, event);

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({
      status: "accepted",
      eventId: event.eventId,
      workflowCreated: true,
      duplicate: false,
    });

    const p = await persisted(event);
    expect(p.employee).toMatchObject({
      email: event.employee.email,
      firstName: "Grace",
      lastName: "Hopper",
    });
    expect(p.workflows).toMatchObject([{ id: body.workflowId, state: "RECEIVED", version: 1 }]);
    expect(p.receipts).toMatchObject([
      {
        eventType: "offer.signed",
        hrisEmployeeId: event.employeeId,
        workflowId: body.workflowId,
        workflowCreated: true,
      },
    ]);
    expect(p.receipts[0]?.payload).toMatchObject({
      role: "Software Engineer",
      department: "Engineering",
      managerId: "HRIS-MGR-1",
    });

    expect(p.outbox).toHaveLength(1);
    const outbox = p.outbox[0]!;
    expect(outbox).toMatchObject({
      aggregateType: "onboarding_workflow",
      aggregateId: body.workflowId,
      eventType: OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted,
      correlationId: `hris:${event.eventId}`,
      publishedAt: null,
      attempts: 0,
    });
    expect(HrisOfferSignedAcceptedPayloadSchema.parse(outbox.payload)).toMatchObject({
      workflowId: body.workflowId,
      workflowCreated: true,
      receiptId: p.receipts[0]!.id,
      hrisEventType: "offer.signed",
    });

    const audit = await createWorkflowService(handle.db).listAuditEvents(body.workflowId);
    expect(audit).toMatchObject([
      {
        eventType: "workflow.created",
        actor: "hris-webhook",
        correlationId: `hris:${event.eventId}`,
      },
    ]);
  });
});

describe("rejected events persist nothing", () => {
  it("invalid signature → 401", async () => {
    const event = offerSignedEvent();
    const res = await deliver(app, event, "wrong-secret-wrong-secret-wrong-secret!");
    expect(res.statusCode).toBe(401);
    await expectNothingPersisted(event);
  });

  it("invalid payload → 400", async () => {
    const event = offerSignedEvent({ managerId: "" });
    const res = await deliver(app, event);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_PAYLOAD" });
    await expectNothingPersisted(event);
  });

  it.each([
    ["unsigned offer", { offerStatus: "PENDING" }],
    ["uncleared candidate", { candidateStatus: "PENDING" }],
    ["rescinded offer", { offerStatus: "RESCINDED" }],
  ])("%s → 422", async (_, overrides) => {
    const event = offerSignedEvent(overrides);
    const res = await deliver(app, event);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "NOT_ELIGIBLE" });
    await expectNothingPersisted(event);
  });
});

describe("idempotency", () => {
  it("acknowledges a redelivered event without writing anything new", async () => {
    const event = offerSignedEvent();
    const first = (await deliver(app, event)).json();
    const again = await deliver(app, event);

    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({
      workflowId: first.workflowId,
      duplicate: true,
      workflowCreated: false,
    });
    const p = await persisted(event);
    expect([p.receipts.length, p.workflows.length, p.outbox.length]).toEqual([1, 1, 1]);
  });

  it("treats a re-serialized but identical event as a duplicate", async () => {
    const event = offerSignedEvent();
    await deliver(app, event);
    // Same content, different key order and whitespace → different raw bytes and signature.
    const { eventId, ...rest } = event;
    const reordered = JSON.stringify({ ...rest, eventId }, null, 2);
    const res = await deliver(app, reordered);
    expect(res.json()).toMatchObject({ duplicate: true });
  });

  it("rejects a reused eventId carrying different content with 409", async () => {
    const event = offerSignedEvent();
    await deliver(app, event);
    const res = await deliver(app, { ...event, role: "Staff Engineer" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "EVENT_ID_CONFLICT" });
    const p = await persisted(event);
    expect([p.receipts.length, p.workflows.length, p.outbox.length]).toEqual([1, 1, 1]);
    expect(p.receipts[0]?.payload).toMatchObject({ role: "Software Engineer" });
  });

  it("creates exactly one workflow and one outbox event under concurrent duplicate deliveries", async () => {
    const event = offerSignedEvent();
    // Two app instances with separate pools, 20 simultaneous deliveries each.
    const other = await buildApp(testConfig({ DATABASE_URL: inject("databaseUrl") }));
    try {
      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, i) => deliver(i % 2 ? other : app, event)),
      );
      expect(responses.map((r) => r.statusCode)).toEqual(Array(40).fill(202));
      const bodies = responses.map((r) => r.json());
      expect(bodies.filter((b) => !b.duplicate)).toHaveLength(1);
      expect(new Set(bodies.map((b) => b.workflowId)).size).toBe(1);

      const p = await persisted(event);
      expect([p.receipts.length, p.workflows.length, p.outbox.length]).toEqual([1, 1, 1]);
      expect(
        await createWorkflowService(handle.db).listAuditEvents(bodies[0].workflowId),
      ).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("serializes duplicates that arrive while the first delivery is still in flight", async () => {
    const event = offerSignedEvent();
    // Hold the first transaction open inside the receipt insert, so every other delivery is
    // guaranteed to arrive before it commits (deterministic, unlike a plain burst).
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_slow_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_id = '${event.eventId}' THEN PERFORM pg_sleep(0.3); END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_slow_receipt ON hris_event_receipts;
      CREATE TRIGGER test_slow_receipt BEFORE INSERT ON hris_event_receipts
        FOR EACH ROW EXECUTE FUNCTION test_slow_receipt();
    `),
    );
    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => deliver(app, event)));
      expect(responses.map((r) => r.statusCode)).toEqual(Array(5).fill(202));
      expect(responses.filter((r) => !r.json().duplicate)).toHaveLength(1);
      const p = await persisted(event);
      expect([p.receipts.length, p.workflows.length, p.outbox.length]).toEqual([1, 1, 1]);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_slow_receipt ON hris_event_receipts`);
    }
  });

  it("reuses the active workflow for a different event about the same employee", async () => {
    const first = offerSignedEvent();
    const second = {
      ...offerSignedEvent(),
      employeeId: first.employeeId,
      employee: first.employee,
    };
    const [a, b] = await Promise.all([deliver(app, first), deliver(app, second)]);
    const [ja, jb] = [a.json(), b.json()];

    expect(ja.workflowId).toBe(jb.workflowId);
    expect([ja.workflowCreated, jb.workflowCreated].sort()).toEqual([false, true]);
    const p = await persisted(first);
    expect(p.workflows).toHaveLength(1);
    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, ja.workflowId));
    expect(outbox).toHaveLength(2);
    const audit = await createWorkflowService(handle.db).listAuditEvents(ja.workflowId);
    expect(audit.map((e) => e.eventType)).toEqual(["workflow.created", "hris.offer_signed.linked"]);
  });

  it("starts a new workflow when the employee's previous one is terminal", async () => {
    const first = offerSignedEvent();
    const { workflowId } = (await deliver(app, first)).json();
    await createWorkflowService(handle.db).transition({
      workflowId,
      to: "FAILED",
      expectedVersion: 1,
      actor: "test",
      reason: "offer withdrawn",
    });

    const rehire = {
      ...offerSignedEvent(),
      employeeId: first.employeeId,
      employee: first.employee,
    };
    const res = (await deliver(app, rehire)).json();
    expect(res).toMatchObject({ workflowCreated: true });
    expect(res.workflowId).not.toBe(workflowId);
  });
});

describe("transaction rollback", () => {
  it("returns 500, persists nothing, and accepts the same event on retry", async () => {
    const event = offerSignedEvent();
    // Fail the last write of the transaction (the outbox insert) for this event only.
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'hrisEventId' = '${event.eventId}' THEN
          RAISE EXCEPTION 'simulated outbox failure';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_fail_outbox ON outbox_events;
      CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_outbox();
    `),
    );
    try {
      const res = await deliver(app, event);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ status: "rejected", error: "INTERNAL_ERROR" });
      await expectNothingPersisted(event);
      const orphanAudit = await handle.db
        .select()
        .from(auditEvents)
        .where(sql`${auditEvents.correlationId} = ${`hris:${event.eventId}`}`);
      expect(orphanAudit).toHaveLength(0);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_fail_outbox ON outbox_events`);
    }

    const retry = await deliver(app, event);
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ workflowCreated: true, duplicate: false });
  });
});
