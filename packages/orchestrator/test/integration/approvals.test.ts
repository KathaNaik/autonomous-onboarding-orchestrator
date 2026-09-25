import {
  approvalCallbackEvents,
  approvals,
  auditEvents,
  createDatabase,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ApprovalProcessingError,
  WorkflowVersionConflictError,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
  type ApprovalService,
  type WorkflowService,
} from "../../src/index.js";
import type { WorkflowState } from "@aoo/shared";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newEmployee } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
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

const LEASE = { ownerId: "w", leaseMs: 30_000 };

/** A workflow in AWAITING_APPROVAL with one verified, approval-required ServiceNow ticket. */
async function awaitingApproval(
  fake = new FakeServiceNow(),
  opts: { resources?: string[]; toState?: "AWAITING_APPROVAL" | "POLICY_REVIEW" } = {},
) {
  let wf = await workflows.createWorkflow({ employee: newEmployee(), actor: "test" });
  const path: WorkflowState[] = [
    "ACCESS_PLANNING",
    "POLICY_REVIEW",
    ...(opts.toState === "POLICY_REVIEW" ? [] : (["AWAITING_APPROVAL"] as const)),
  ];
  for (const to of path) {
    wf = await workflows.transition({
      workflowId: wf.id,
      to,
      expectedVersion: wf.version,
      actor: "test",
    });
  }
  const ops = createExternalOperationService(handle.db, {
    servicenow: fake,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const tickets = [];
  for (const resourceId of opts.resources ?? ["test:resource:approval"]) {
    const { operation } = await ops.requestServiceNowAccessRequest({
      workflowId: wf.id,
      employeeId: "TEST-EMP-M4C",
      resourceId,
      requestedEntitlement: "member",
      agentReason: "Synthetic approval test",
      policyDecision: "requires_approval",
      actor: "test",
    });
    const done = await ops.execute(operation.id, LEASE);
    tickets.push({ operation, sysId: done.externalId, number: done.externalReference });
  }
  return { fake, workflowId: wf.id, tickets, ticket: tickets[0]! };
}

function service(fake: FakeServiceNow, wf: WorkflowService = workflows, db = handle) {
  return createApprovalService(db.db, { servicenow: fake, workflows: wf });
}

function callback(
  t: { operation: { correlationKey: string }; sysId: string; number: string },
  eventSuffix: string,
  claimed?: string,
) {
  return {
    eventId: `${t.sysId}:${eventSuffix}`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: t.sysId,
    number: t.number,
    correlationKey: t.operation.correlationKey,
    ...(claimed && { claimedApprovalState: claimed }),
  };
}

async function deliver(svc: ApprovalService, cb: ReturnType<typeof callback>) {
  const { callbackEventId } = await svc.recordServiceNowCallback(cb);
  return svc.processCallback(callbackEventId);
}

const workflowState = async (id: string) => (await workflows.getWorkflow(id))!.workflow;
const approvalOf = async (opId: string) =>
  (await handle.db.select().from(approvals).where(eq(approvals.externalOperationId, opId)))[0]!;
const transitionsTo = async (workflowId: string, to: string) =>
  (await workflows.listAuditEvents(workflowId)).filter(
    (e) => e.eventType === "workflow.transitioned" && e.toState === to,
  );

describe("approval lifecycle", () => {
  it("creating an approval-required ticket creates a PENDING approval with the verified ids", async () => {
    const { ticket, workflowId } = await awaitingApproval();
    expect(await approvalOf(ticket.operation.id)).toMatchObject({
      workflowId,
      status: "PENDING",
      externalId: ticket.sysId,
      externalReference: ticket.number,
      correlationKey: ticket.operation.correlationKey,
      providerState: "pending",
      decidedAt: null,
    });
  });

  it("a verified approval resumes AWAITING_APPROVAL → PROVISIONING exactly once", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const result = await deliver(service(fake), callback(ticket, "5", "approved"));

    expect(result).toMatchObject({
      outcome: "APPLIED_APPROVED",
      approvalStatus: "APPROVED",
      workflowResumed: true,
    });
    expect(await approvalOf(ticket.operation.id)).toMatchObject({
      status: "APPROVED",
      decidedByEventId: `${ticket.sysId}:5`,
      providerState: "approved",
      version: 2,
    });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
    const resumed = await transitionsTo(workflowId, "PROVISIONING");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      actor: "approval-verifier",
      idempotencyKey: expect.stringMatching(/^approval-resume:/),
    });
    const audit = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, "approval.approved")),
      );
    expect(audit).toHaveLength(1);
  });

  it("a verified rejection is recorded and ends the approval phase once nothing is pending (M6B)", async () => {
    // M4C left the workflow in AWAITING_APPROVAL on rejection. Since M6B the rejected resource is
    // REJECTED in its own per-resource record, and the workflow moves on when no approval is
    // pending, whatever the outcomes (otherwise approve-then-reject would strand it forever).
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "rejected");
    const result = await deliver(service(fake), callback(ticket, "5", "rejected"));
    expect(result).toMatchObject({
      outcome: "APPLIED_REJECTED",
      approvalStatus: "REJECTED",
      workflowResumed: true,
    });
    expect(await approvalOf(ticket.operation.id)).toMatchObject({ status: "REJECTED" });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
  });

  it("approve one resource, then reject the last pending one: the workflow still moves on (M6B)", async () => {
    const { fake, tickets, workflowId } = await awaitingApproval(new FakeServiceNow(), {
      resources: ["test:resource:a", "test:resource:b"],
    });
    const [a, b] = tickets as [(typeof tickets)[0], (typeof tickets)[0]];
    fake.setApprovalState(a.sysId, "approved");
    expect(await deliver(service(fake), callback(a, "5"))).toMatchObject({
      workflowResumed: false,
    });
    fake.setApprovalState(b.sysId, "rejected");
    expect(await deliver(service(fake), callback(b, "5"))).toMatchObject({ workflowResumed: true });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
  });

  it("does not require every workflow to pass through AWAITING_APPROVAL", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval(new FakeServiceNow(), {
      toState: "POLICY_REVIEW",
    });
    fake.setApprovalState(ticket.sysId, "approved");
    const result = await deliver(service(fake), callback(ticket, "5"));
    expect(result).toMatchObject({ outcome: "APPLIED_APPROVED", workflowResumed: false });
    expect(await workflowState(workflowId)).toMatchObject({ state: "POLICY_REVIEW" });
  });

  it("with two approval-required resources, resumes only after the last one is approved", async () => {
    const { fake, tickets, workflowId } = await awaitingApproval(new FakeServiceNow(), {
      resources: ["test:r:one", "test:r:two"],
    });
    const svc = service(fake);
    fake.setApprovalState(tickets[0]!.sysId, "approved");
    expect(await deliver(svc, callback(tickets[0]!, "5"))).toMatchObject({
      outcome: "APPLIED_APPROVED",
      workflowResumed: false,
    });
    expect(await workflowState(workflowId)).toMatchObject({ state: "AWAITING_APPROVAL" });
    fake.setApprovalState(tickets[1]!.sysId, "approved");
    expect(await deliver(svc, callback(tickets[1]!, "5"))).toMatchObject({
      outcome: "APPLIED_APPROVED",
      workflowResumed: true,
    });
    expect(await transitionsTo(workflowId, "PROVISIONING")).toHaveLength(1);
  });
});

describe("the callback is never authoritative", () => {
  it("callback says approved, ServiceNow still pending → nothing granted or resumed", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    const result = await deliver(service(fake), callback(ticket, "5", "approved"));
    expect(result).toMatchObject({
      outcome: "STILL_PENDING",
      approvalStatus: "PENDING",
      workflowResumed: false,
    });
    expect(await approvalOf(ticket.operation.id)).toMatchObject({
      status: "PENDING",
      decidedAt: null,
    });
    expect(await workflowState(workflowId)).toMatchObject({ state: "AWAITING_APPROVAL" });
    const [cb] = await handle.db
      .select()
      .from(approvalCallbackEvents)
      .where(eq(approvalCallbackEvents.eventId, `${ticket.sysId}:5`));
    expect(cb).toMatchObject({
      status: "PROCESSED",
      outcome: "STILL_PENDING",
      outcomeDetail: { verifiedState: "PENDING", claimMismatch: true },
    });
    expect(fake.reads).toBeGreaterThan(0);
  });

  it("callback claims approved while ServiceNow says rejected → the authoritative rejection is applied", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "rejected");
    const result = await deliver(service(fake), callback(ticket, "5", "approved"));
    expect(result).toMatchObject({ outcome: "APPLIED_REJECTED", approvalStatus: "REJECTED" });
    // The claimed approval granted nothing: the approval is REJECTED. (Since M6B a decided
    // rejection ends the approval phase, so the workflow moves on with nothing approved.)
    expect(await approvalOf(ticket.operation.id)).toMatchObject({ status: "REJECTED" });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
  });

  it("unknown ticket, mismatched sys_id / number, and a provider record with another correlation key are rejected", async () => {
    const { fake, ticket } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const svc = service(fake);
    expect(
      await deliver(svc, {
        ...callback(ticket, "1"),
        correlationKey: "aoo-test-oar-unknown-000000000000000000000000",
      }),
    ).toMatchObject({ outcome: "UNKNOWN_TICKET", approvalStatus: null });
    expect(await deliver(svc, { ...callback(ticket, "2"), sysId: "f".repeat(32) })).toMatchObject({
      outcome: "IDENTITY_MISMATCH",
    });
    expect(await deliver(svc, { ...callback(ticket, "3"), number: "OAR9999999" })).toMatchObject({
      outcome: "IDENTITY_MISMATCH",
    });
    fake.records.find((r) => r.sysId === ticket.sysId)!.correlationKey =
      "aoo-test-oar-someone-else";
    expect(await deliver(svc, callback(ticket, "4"))).toMatchObject({
      outcome: "IDENTITY_MISMATCH",
    });
    const rejected = await handle.db
      .select()
      .from(approvalCallbackEvents)
      .where(
        and(
          eq(approvalCallbackEvents.status, "REJECTED"),
          sql`${approvalCallbackEvents.eventId} LIKE ${`${ticket.sysId}:%`}`,
        ),
      );
    expect(rejected).toHaveLength(4); // unknown ticket, sysId, number, provider correlation key
    expect(await approvalOf(ticket.operation.id)).toMatchObject({ status: "PENDING" });
  });
});

describe("duplicates, replays and races", () => {
  it("a duplicate delivery is recorded once and applied once", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const svc = service(fake);
    const cb = callback(ticket, "5");
    const first = await svc.recordServiceNowCallback(cb);
    const again = await svc.recordServiceNowCallback(cb);
    expect(again).toEqual({ callbackEventId: first.callbackEventId, duplicate: true });
    const events = await handle.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'callbackEventId' = ${first.callbackEventId}`);
    expect(events).toHaveLength(1);
    await svc.processCallback(first.callbackEventId);
    expect(await svc.processCallback(first.callbackEventId)).toMatchObject({
      alreadyProcessed: true,
      outcome: "APPLIED_APPROVED",
    });
    expect(await transitionsTo(workflowId, "PROVISIONING")).toHaveLength(1);
    await expect(
      svc.recordServiceNowCallback({ ...cb, number: "OAR0000000" }),
    ).rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
  });

  it("concurrent duplicate callbacks: one row; concurrent distinct events: one decision, one resume", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const other = createDatabase(inject("databaseUrl"));
    try {
      const a = service(fake);
      const b = service(fake, workflows, other);
      const cb = callback(ticket, "7");
      const recorded = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).recordServiceNowCallback(cb)),
      );
      expect(recorded.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(recorded.map((r) => r.callbackEventId)).size).toBe(1);

      // Two different change events for the same approval, processed simultaneously by two workers.
      const e1 = await a.recordServiceNowCallback(callback(ticket, "8"));
      const results = await Promise.all([
        a.processCallback(e1.callbackEventId),
        b.processCallback(recorded[0]!.callbackEventId),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["ALREADY_APPLIED", "APPLIED_APPROVED"]);
      expect(await transitionsTo(workflowId, "PROVISIONING")).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("replay after a process restart (new service instance and pool) changes nothing", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const cb = callback(ticket, "5");
    await deliver(service(fake), cb);
    const restarted = createDatabase(inject("databaseUrl"));
    try {
      const svc = service(fake, createWorkflowService(restarted.db), restarted);
      const replay = await svc.recordServiceNowCallback(cb);
      expect(replay.duplicate).toBe(true);
      expect(await svc.processCallback(replay.callbackEventId)).toMatchObject({
        alreadyProcessed: true,
      });
    } finally {
      await restarted.close();
    }
    expect(await transitionsTo(workflowId, "PROVISIONING")).toHaveLength(1);
  });

  it("approval then a repeated approval callback; rejection then a duplicate rejection", async () => {
    const approved = await awaitingApproval();
    approved.fake.setApprovalState(approved.ticket.sysId, "approved");
    const svcA = service(approved.fake);
    await deliver(svcA, callback(approved.ticket, "5"));
    expect(await deliver(svcA, callback(approved.ticket, "6"))).toMatchObject({
      outcome: "ALREADY_APPLIED",
      approvalStatus: "APPROVED",
    });
    expect(await transitionsTo(approved.workflowId, "PROVISIONING")).toHaveLength(1);

    const rejected = await awaitingApproval();
    rejected.fake.setApprovalState(rejected.ticket.sysId, "rejected");
    const svcR = service(rejected.fake);
    await deliver(svcR, callback(rejected.ticket, "5"));
    expect(await deliver(svcR, callback(rejected.ticket, "6"))).toMatchObject({
      outcome: "ALREADY_APPLIED",
      approvalStatus: "REJECTED",
    });
  });

  it("stale callbacks reconcile to the current ServiceNow state; a later contradicting change is surfaced, never flipped", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    const svc = service(fake);
    // Event #5 was sent when the ticket was approved, but it arrives after a change to rejected.
    fake.setApprovalState(ticket.sysId, "rejected");
    expect(await deliver(svc, callback(ticket, "5", "approved"))).toMatchObject({
      outcome: "APPLIED_REJECTED",
    });
    // Someone flips it to approved afterwards: the applied decision stands; conflict is recorded.
    fake.setApprovalState(ticket.sysId, "approved");
    expect(await deliver(svc, callback(ticket, "6", "approved"))).toMatchObject({
      outcome: "DECISION_CONFLICT",
      approvalStatus: "REJECTED",
    });
    expect(await approvalOf(ticket.operation.id)).toMatchObject({ status: "REJECTED" });
    // Never flipped to APPROVED; the rejection ended the approval phase (M6B).
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
    const conflict = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, "approval.conflict")),
      );
    expect(conflict).toHaveLength(1);
  });
});

describe("failures and retries", () => {
  it("ServiceNow read temporarily unavailable → notification kept (RECEIVED), sanitized error, retry applies it", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    fake.failNextReads = 1;
    const svc = service(fake);
    const { callbackEventId } = await svc.recordServiceNowCallback(callback(ticket, "5"));
    await expect(svc.processCallback(callbackEventId)).rejects.toMatchObject({
      code: "RETRY_LATER",
      retryable: true,
    });
    const [kept] = await handle.db
      .select()
      .from(approvalCallbackEvents)
      .where(eq(approvalCallbackEvents.id, callbackEventId));
    expect(kept).toMatchObject({ status: "RECEIVED", attempts: 1, processedAt: null });
    expect(kept!.lastError).toMatch(/^servicenow:UNAVAILABLE \(503\)/);
    await expect(svc.processCallback(callbackEventId)).resolves.toMatchObject({
      outcome: "APPLIED_APPROVED",
      workflowResumed: true,
    });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
  });

  it("persistence failure rolls back the whole decision; the callback stays RECEIVED and a retry succeeds", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const svc = service(fake);
    const { callbackEventId } = await svc.recordServiceNowCallback(callback(ticket, "5"));
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'approval.approved' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END $$;
      DROP TRIGGER IF EXISTS test_fail_approval_audit ON audit_events;
      CREATE TRIGGER test_fail_approval_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_fail_approval_audit();`),
    );
    try {
      await expect(svc.processCallback(callbackEventId)).rejects.toThrow();
      expect(await approvalOf(ticket.operation.id)).toMatchObject({
        status: "PENDING",
        decidedAt: null,
        version: 1,
      });
      const [cb] = await handle.db
        .select()
        .from(approvalCallbackEvents)
        .where(eq(approvalCallbackEvents.id, callbackEventId));
      expect(cb).toMatchObject({ status: "RECEIVED", outcome: null });
      expect(await workflowState(workflowId)).toMatchObject({ state: "AWAITING_APPROVAL" });
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_fail_approval_audit ON audit_events`);
    }
    await expect(svc.processCallback(callbackEventId)).resolves.toMatchObject({
      outcome: "APPLIED_APPROVED",
      workflowResumed: true,
    });
  });

  it("workflow version conflict during resume → retried; approval applied once, workflow resumed once", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    let conflicts = 1;
    const flaky: WorkflowService = {
      ...workflows,
      transition: async (input) => {
        if (conflicts-- > 0)
          throw new WorkflowVersionConflictError(
            workflowId,
            input.expectedVersion,
            input.expectedVersion + 1,
          );
        return workflows.transition(input);
      },
    };
    const svc = service(fake, flaky);
    const { callbackEventId } = await svc.recordServiceNowCallback(callback(ticket, "5"));
    const err = await svc.processCallback(callbackEventId).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalProcessingError);
    expect(err).toMatchObject({ code: "RETRY_LATER", retryable: true });
    expect(await approvalOf(ticket.operation.id)).toMatchObject({ status: "APPROVED" });
    expect(await workflowState(workflowId)).toMatchObject({ state: "AWAITING_APPROVAL" });

    await expect(svc.processCallback(callbackEventId)).resolves.toMatchObject({
      alreadyProcessed: true,
      workflowResumed: true,
    });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
    expect(await transitionsTo(workflowId, "PROVISIONING")).toHaveLength(1);
  });

  it("end-to-end through the outbox worker, with sanitized errors on the retry path", async () => {
    const { fake, ticket, workflowId } = await awaitingApproval();
    fake.setApprovalState(ticket.sysId, "approved");
    const svc = service(fake);
    fake.getAccessRequest = (() => {
      let calls = 0;
      const original = FakeServiceNow.prototype.getAccessRequest.bind(fake);
      return async (id: string) => {
        if (calls++ === 0)
          throw new Error(
            "fetch failed: Authorization: Basic c2VjcmV0OnNlY3JldA== Cookie: JSESSIONID=abc123 employee TEST-EMP-M4C",
          );
        return original(id);
      };
    })();
    const { callbackEventId } = await svc.recordServiceNowCallback(callback(ticket, "5"));
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "approvals-test",
      batchSize: 10,
      leaseMs: 30_000,
      retry: { maxAttempts: 5, backoffBaseMs: 10, backoffMaxMs: 10 },
      handlers: createEventHandlers({ workflows, approvals: svc }),
      random: () => 0,
    });
    expect(await runner.runOnce()).toMatchObject({ retried: 1 });
    const [cbAfterFailure] = await handle.db
      .select()
      .from(approvalCallbackEvents)
      .where(eq(approvalCallbackEvents.id, callbackEventId));
    const [outbox] = await handle.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'callbackEventId' = ${callbackEventId}`);
    const stored = JSON.stringify([cbAfterFailure!.lastError, outbox!.lastError]);
    for (const secret of ["c2VjcmV0OnNlY3JldA==", "JSESSIONID=abc123", "TEST-EMP-M4C"])
      expect(stored).not.toContain(secret);

    await new Promise((r) => setTimeout(r, 30));
    expect(await runner.runOnce()).toMatchObject({ succeeded: 1 });
    expect(await workflowState(workflowId)).toMatchObject({ state: "PROVISIONING" });
  });
});
