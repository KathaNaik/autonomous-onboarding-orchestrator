import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabase,
  outboxEvents,
  workflowSteps,
  type DatabaseHandle,
} from "@aoo/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  LeaseLostError,
  PermanentEventError,
  createEventHandlers,
  createHrisIntakeService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
  noopLogger,
  workflowStartKey,
  type EventHandlerRegistry,
  type OutboxRunnerOptions,
  type PostgresOutboxStore,
  type WorkflowService,
} from "../../src/index.js";
import { newOfferSignedEvent, sleep } from "./helpers.js";

let handle: DatabaseHandle;
let store: PostgresOutboxStore;
let workflows: WorkflowService;
let handlers: EventHandlerRegistry;

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  store = createPostgresOutboxStore(handle.db);
  workflows = createWorkflowService(handle.db);
  handlers = createEventHandlers({ workflows });
});
afterAll(() => handle.close());

// Each test owns the queue: park anything a previous test left claimable.
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events
       SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
           lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
           last_error = 'parked by test cleanup'
     WHERE status = 'PENDING'`);
});

const retry = { maxAttempts: 3, backoffBaseMs: 200, backoffMaxMs: 1000 };

function runner(workerId: string, overrides: Partial<OutboxRunnerOptions> = {}, s = store) {
  return createOutboxRunner(s, {
    workerId,
    batchSize: 10,
    leaseMs: 30_000,
    retry,
    handlers,
    logger: noopLogger,
    random: () => 0,
    ...overrides,
  });
}

async function drain(r: ReturnType<typeof runner>) {
  let total = 0;
  for (;;) {
    const s = await r.runOnce();
    total += s.claimed;
    if (s.claimed === 0) return total;
  }
}

/** Accepts an HRIS event through the real intake path; returns its outbox row. */
async function acceptHris(event = newOfferSignedEvent()) {
  const result = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  const [row] = await handle.db
    .select()
    .from(outboxEvents)
    .where(sql`${outboxEvents.payload}->>'hrisEventId' = ${event.eventId}`);
  return { ...result, event, outboxId: row!.id };
}

async function outboxRow(id: string) {
  const [row] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  return row!;
}

async function insertTestEvent(eventType: string) {
  const [row] = await handle.db
    .insert(outboxEvents)
    .values({
      idempotencyKey: `test:${randomUUID()}`,
      aggregateType: "test",
      aggregateId: randomUUID(),
      eventType,
      payload: {},
    })
    .returning();
  return row!;
}

async function workflowHistory(workflowId: string) {
  const details = await workflows.getWorkflow(workflowId);
  const audit = await workflows.listAuditEvents(workflowId);
  return { workflow: details!.workflow, steps: details!.steps, audit };
}

function expectStartedOnce(h: Awaited<ReturnType<typeof workflowHistory>>) {
  expect(h.workflow).toMatchObject({ state: "ACCESS_PLANNING", version: 2 });
  expect(h.steps.map((s) => [s.stepKey, s.status])).toEqual([
    ["RECEIVED", "SUCCEEDED"],
    ["ACCESS_PLANNING", "RUNNING"],
  ]);
  expect(h.audit.map((e) => e.eventType)).toEqual(["workflow.created", "workflow.transitioned"]);
}

describe("successful processing", () => {
  it("starts a new workflow and marks the outbox event processed with its attempt history", async () => {
    const accepted = await acceptHris();
    const summary = await runner("w1").runOnce();
    expect(summary).toMatchObject({ succeeded: 1, retried: 0, deadLettered: 0 });

    const h = await workflowHistory(accepted.workflowId);
    expectStartedOnce(h);
    expect(h.audit[1]).toMatchObject({
      actor: "outbox-worker",
      fromState: "RECEIVED",
      toState: "ACCESS_PLANNING",
      idempotencyKey: workflowStartKey(accepted.workflowId),
      correlationId: `hris:${accepted.event.eventId}`,
    });

    const row = await outboxRow(accepted.outboxId);
    expect(row).toMatchObject({
      status: "PROCESSED",
      attempts: 1,
      cycleAttempts: 1,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { attemptNumber: 1, workerId: "w1", outcome: "SUCCEEDED", detail: { status: "processed" } },
    ]);
  });
});

describe("duplicate deliveries", () => {
  it("a redelivered, already-processed event causes no new transition, steps or audit", async () => {
    const accepted = await acceptHris();
    await runner("w1").runOnce();

    // Simulate at-least-once redelivery of the same event.
    await handle.db
      .update(outboxEvents)
      .set({ status: "PENDING", publishedAt: null })
      .where(eq(outboxEvents.id, accepted.outboxId));
    const summary = await runner("w2").runOnce();

    // (M10) the batch may also hold the access-planning request written by the start.
    expect(summary).toMatchObject({ retried: 0, deadLettered: 0, leaseLost: 0 });
    expect(summary.succeeded).toBe(summary.claimed);
    expectStartedOnce(await workflowHistory(accepted.workflowId));
    expect((await store.listAttempts(accepted.outboxId)).map((a) => a.outcome)).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
    ]);
  });

  it("concurrent handler invocations for the same event start the workflow exactly once", async () => {
    const accepted = await acceptHris();
    const handler = handlers["hris.offer_signed.accepted"]!;
    const row = await outboxRow(accepted.outboxId);
    const envelope = {
      id: row.id,
      type: row.eventType,
      payload: row.payload,
      correlationId: row.correlationId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      deliveryAttempt: 1,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => handler(envelope, { logger: noopLogger })),
    );
    expect(results.every((r) => r.status === "processed")).toBe(true);
    expectStartedOnce(await workflowHistory(accepted.workflowId));
  });
});

describe("concurrent workers", () => {
  it("four workers drain 24 events with no event claimed twice", async () => {
    const accepted = await Promise.all(Array.from({ length: 24 }, () => acceptHris()));
    const claimedBy = new Map<string, string[]>();

    const workers = ["wa", "wb", "wc", "wd"].map((id) => {
      const recording: PostgresOutboxStore = {
        ...store,
        async claim(p) {
          const claims = await store.claim(p);
          for (const c of claims) claimedBy.set(c.id, [...(claimedBy.get(c.id) ?? []), id]);
          return claims;
        },
      };
      return runner(id, { batchSize: 3 }, recording);
    });
    await Promise.all(workers.map(drain));

    const ids = accepted.map((a) => a.outboxId);
    for (const id of ids) expect(claimedBy.get(id)).toHaveLength(1);
    expect(new Set([...claimedBy.values()].flat()).size).toBeGreaterThan(1); // work was shared

    const rows = await handle.db.select().from(outboxEvents).where(inArray(outboxEvents.id, ids));
    expect(rows.every((r) => r.status === "PROCESSED" && r.attempts === 1)).toBe(true);
    for (const a of accepted) expectStartedOnce(await workflowHistory(a.workflowId));
  });

  it("a valid lease hides the event from every other claimer", async () => {
    const accepted = await acceptHris();
    const [claim] = await store.claim({ workerId: "holder", batchSize: 10, leaseMs: 30_000 });
    expect(claim?.id).toBe(accepted.outboxId);

    const others = await Promise.all(
      ["x", "y", "z"].map((w) => store.claim({ workerId: w, batchSize: 10, leaseMs: 30_000 })),
    );
    expect(others.flat().map((c) => c.id)).not.toContain(accepted.outboxId);
    await store.complete(claim!, { status: "processed" });
  });
});

describe("worker crashes and lease recovery", () => {
  const LEASE_MS = 300;

  it("crash before the transition: another worker reclaims after lease expiry and starts the workflow", async () => {
    const accepted = await acceptHris();
    // Worker A claims, then dies without running the handler.
    const [claimA] = await store.claim({ workerId: "crashy", batchSize: 1, leaseMs: LEASE_MS });
    expect(claimA?.id).toBe(accepted.outboxId);

    expect((await runner("rescuer", { leaseMs: LEASE_MS }).runOnce()).claimed).toBe(0);
    await sleep(LEASE_MS + 100);
    expect((await runner("rescuer", { leaseMs: LEASE_MS }).runOnce()).succeeded).toBe(1);

    expectStartedOnce(await workflowHistory(accepted.workflowId));
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { attemptNumber: 1, workerId: "crashy", outcome: "LEASE_EXPIRED" },
      { attemptNumber: 2, workerId: "rescuer", outcome: "SUCCEEDED" },
    ]);
  });

  it("crash after the transition but before the ack: the retry recognizes the committed start", async () => {
    const accepted = await acceptHris();
    const [claimA] = await store.claim({ workerId: "crashy", batchSize: 1, leaseMs: LEASE_MS });
    // Worker A runs the handler (transition commits) and dies before acknowledging.
    await handlers[claimA!.eventType]!(
      {
        id: claimA!.id,
        type: claimA!.eventType,
        payload: claimA!.payload,
        correlationId: claimA!.correlationId,
        aggregateType: claimA!.aggregateType,
        aggregateId: claimA!.aggregateId,
        deliveryAttempt: 1,
      },
      { logger: noopLogger },
    );
    expectStartedOnce(await workflowHistory(accepted.workflowId));
    expect((await outboxRow(accepted.outboxId)).status).toBe("PENDING");

    await sleep(LEASE_MS + 100);
    // (M10) plus the access-planning request the committed start wrote
    expect((await runner("rescuer", { leaseMs: LEASE_MS }).runOnce()).succeeded).toBe(2);

    const h = await workflowHistory(accepted.workflowId);
    expectStartedOnce(h); // no duplicate step or audit event
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { workerId: "crashy", outcome: "LEASE_EXPIRED" },
      {
        workerId: "rescuer",
        outcome: "SUCCEEDED",
        detail: { state: "ACCESS_PLANNING", version: 2 },
      },
    ]);
    expect((await outboxRow(accepted.outboxId)).status).toBe("PROCESSED");
  });

  it("a stale worker cannot acknowledge or fail after its lease was reclaimed", async () => {
    const accepted = await acceptHris();
    const [stale] = await store.claim({ workerId: "stale", batchSize: 1, leaseMs: LEASE_MS });
    await sleep(LEASE_MS + 100);
    const [fresh] = await store.claim({ workerId: "fresh", batchSize: 1, leaseMs: 30_000 });
    expect(fresh?.id).toBe(accepted.outboxId);
    expect(fresh?.leaseToken).not.toBe(stale?.leaseToken);

    await expect(store.complete(stale!, { status: "processed" })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      store.fail(stale!, {
        error: { name: "Error", message: "late" },
        deadLetter: true,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const row = await outboxRow(accepted.outboxId);
    expect(row).toMatchObject({
      status: "PENDING",
      leaseOwner: "fresh",
      leaseToken: fresh!.leaseToken,
    });

    await store.complete(fresh!, { status: "processed" });
    expect((await outboxRow(accepted.outboxId)).status).toBe("PROCESSED");
  });

  it("an expired lease cannot be acknowledged even if nobody reclaimed it yet", async () => {
    const accepted = await acceptHris();
    const [claim] = await store.claim({ workerId: "slow", batchSize: 1, leaseMs: LEASE_MS });
    await sleep(LEASE_MS + 100);
    await expect(store.complete(claim!, { status: "processed" })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect((await outboxRow(accepted.outboxId)).status).toBe("PENDING");
  });

  it("the runner reports a lost lease instead of failing when its handler outlives the lease", async () => {
    const accepted = await acceptHris();
    const slowHandlers: EventHandlerRegistry = {
      "hris.offer_signed.accepted": async (e, ctx) => {
        await sleep(LEASE_MS + 100);
        return handlers["hris.offer_signed.accepted"]!(e, ctx);
      },
    };
    const summary = await runner("slow", {
      leaseMs: LEASE_MS,
      handlers: slowHandlers,
      heartbeatIntervalMs: false, // a stalled process: no heartbeat
    }).runOnce();
    expect(summary).toMatchObject({ claimed: 1, succeeded: 0, leaseLost: 1 });
    expect((await outboxRow(accepted.outboxId)).status).toBe("PENDING");

    // Recovery: the next worker finishes it without a second start (M10: plus the
    // access-planning request written by the stale run's committed start).
    expect((await runner("next").runOnce()).succeeded).toBe(2);
    expectStartedOnce(await workflowHistory(accepted.workflowId));
  });
});

describe("(M10) lease heartbeat", () => {
  const LEASE_MS = 300;

  it("a handler running several times longer than its lease keeps it, and no other worker can claim", async () => {
    const accepted = await acceptHris();
    let calls = 0;
    const slowHandlers: EventHandlerRegistry = {
      "hris.offer_signed.accepted": async (e, ctx) => {
        calls += 1;
        await sleep(LEASE_MS * 4);
        return handlers["hris.offer_signed.accepted"]!(e, ctx);
      },
    };
    const holder = runner("holder", {
      leaseMs: LEASE_MS,
      handlers: slowHandlers,
      heartbeatIntervalMs: 80,
    }).runOnce();
    // Meanwhile another worker keeps polling with the same handlers; the lease is always live.
    for (let i = 0; i < 10; i++) {
      await sleep(LEASE_MS / 2);
      await runner("thief", { leaseMs: LEASE_MS, handlers: slowHandlers }).runOnce();
    }
    expect(await holder).toMatchObject({ claimed: 1, succeeded: 1, leaseLost: 0 });
    // The HRIS event was only ever claimed by the holder (the thief may take the follow-up
    // access-planning request the start wrote, which is a different event).
    expect((await store.listAttempts(accepted.outboxId)).map((a) => a.workerId)).toEqual([
      "holder",
    ]);
    expect(calls).toBe(1);
    expectStartedOnce(await workflowHistory(accepted.workflowId));
    const [attempt] = await store.listAttempts(accepted.outboxId);
    expect(attempt).toMatchObject({ workerId: "holder", outcome: "SUCCEEDED" });
    // The attempt's recorded expiry moved forward with the renewals.
    expect(attempt!.leaseExpiresAt.getTime() - attempt!.claimedAt.getTime()).toBeGreaterThan(
      LEASE_MS * 2,
    );
  });

  it("only the current owner can renew: stale, reclaimed and expired leases are refused", async () => {
    const accepted = await acceptHris();
    const [stale] = await store.claim({ workerId: "stale", batchSize: 1, leaseMs: LEASE_MS });
    const renewed = await store.renew(stale!, LEASE_MS);
    expect(renewed.getTime()).toBeGreaterThan(stale!.leaseExpiresAt.getTime());
    await sleep(LEASE_MS + 100);
    // Expired (nobody reclaimed yet): renewal is refused, the event is recoverable.
    await expect(store.renew(stale!, LEASE_MS)).rejects.toBeInstanceOf(LeaseLostError);
    const [fresh] = await store.claim({ workerId: "fresh", batchSize: 1, leaseMs: 30_000 });
    expect(fresh?.id).toBe(accepted.outboxId);
    // Reclaimed: the stale owner can neither renew, acknowledge nor fail.
    await expect(store.renew(stale!, 60_000)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.complete(stale!, { status: "processed" })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    const row = await outboxRow(accepted.outboxId);
    expect(row).toMatchObject({ leaseOwner: "fresh", leaseToken: fresh!.leaseToken });
    expect(row.leaseExpiresAt!.getTime()).toBe(fresh!.leaseExpiresAt.getTime());
    await store.complete(fresh!, { status: "processed" });
  });

  it("the heartbeat stops when the handler finishes (no renewal afterwards)", async () => {
    await acceptHris();
    let renewals = 0;
    const counting: PostgresOutboxStore = {
      ...store,
      renew: async (claim, leaseMs) => {
        renewals += 1;
        return store.renew(claim, leaseMs);
      },
    };
    const summary = await runner(
      "short",
      {
        leaseMs: LEASE_MS,
        heartbeatIntervalMs: 40,
        handlers: {
          "hris.offer_signed.accepted": async (e, ctx) => {
            await sleep(200);
            return handlers["hris.offer_signed.accepted"]!(e, ctx);
          },
        },
      },
      counting,
    ).runOnce();
    expect(summary.succeeded).toBe(1);
    const after = renewals;
    expect(after).toBeGreaterThan(0);
    await sleep(300);
    expect(renewals).toBe(after);
  });

  it("a lease lost during the handler stops the heartbeat and the result is discarded", async () => {
    const accepted = await acceptHris();
    const slow: EventHandlerRegistry = {
      "hris.offer_signed.accepted": async (e, ctx) => {
        // Simulate a pause longer than the lease (e.g. a frozen instance): force expiry + reclaim.
        await handle.db.execute(
          sql`UPDATE outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${accepted.outboxId}`,
        );
        await store.claim({ workerId: "rescuer", batchSize: 1, leaseMs: 30_000 });
        await sleep(200);
        return handlers["hris.offer_signed.accepted"]!(e, ctx);
      },
    };
    const summary = await runner("paused", {
      leaseMs: LEASE_MS,
      heartbeatIntervalMs: 40,
      handlers: slow,
    }).runOnce();
    expect(summary).toMatchObject({ succeeded: 0, leaseLost: 1 });
    expect(await outboxRow(accepted.outboxId)).toMatchObject({
      status: "PENDING",
      leaseOwner: "rescuer",
    });
  });
});

describe("retries, backoff and dead-lettering", () => {
  const failing: EventHandlerRegistry = {
    "test.always_fails": async () => {
      throw Object.assign(new Error("downstream unavailable"), { code: "ECONNREFUSED" });
    },
  };

  it("backs off exponentially, then dead-letters with the full attempt history", async () => {
    const row = await insertTestEvent("test.always_fails");
    const r = runner("retrier", { handlers: failing });

    expect(await r.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    let current = await outboxRow(row.id);
    expect(current).toMatchObject({ status: "PENDING", cycleAttempts: 1, leaseToken: null });
    expect(current.lastError).toBe("Error: downstream unavailable");
    // Not claimable during the backoff window.
    expect((await r.runOnce()).claimed).toBe(0);

    await sleep(150); // first delay: cap 200ms → random 0 → 100ms
    expect(await r.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    await sleep(250); // second delay: cap 400ms → 200ms
    expect(await r.runOnce()).toMatchObject({ claimed: 1, deadLettered: 1 });

    current = await outboxRow(row.id);
    expect(current).toMatchObject({ status: "DEAD_LETTERED", attempts: 3, cycleAttempts: 3 });
    expect(current.deadLetteredAt).toBeInstanceOf(Date);

    const attempts = await store.listAttempts(row.id);
    expect(attempts.map((a) => [a.attemptNumber, a.outcome])).toEqual([
      [1, "FAILED"],
      [2, "FAILED"],
      [3, "DEAD_LETTERED"],
    ]);
    expect(attempts.map((a) => a.detail?.retryDelayMs)).toEqual([100, 200, undefined]);
    expect(attempts[0]).toMatchObject({
      error: "Error: downstream unavailable",
      detail: { error: { name: "Error", message: "downstream unavailable", code: "ECONNREFUSED" } },
    });
    expect((await r.runOnce()).claimed).toBe(0); // dead letters are never claimed
  });

  it("schedules the retry at the computed backoff (DB clock)", async () => {
    const row = await insertTestEvent("test.always_fails");
    await runner("timer", { handlers: failing }).runOnce();
    const [{ delayMs }] = (
      await handle.db.execute<{ delayMs: number }>(sql`
        SELECT extract(epoch FROM (o.available_at - a.finished_at)) * 1000 AS "delayMs"
          FROM outbox_events o JOIN outbox_event_attempts a ON a.outbox_event_id = o.id
         WHERE o.id = ${row.id}`)
    ).rows as [{ delayMs: number }];
    expect(Number(delayMs)).toBeGreaterThanOrEqual(95);
    expect(Number(delayMs)).toBeLessThan(150);
  });

  it("dead-letters a permanent error immediately", async () => {
    const row = await insertTestEvent("test.permanent");
    await runner("p", {
      handlers: {
        "test.permanent": async () => {
          throw new PermanentEventError("payload can never be valid");
        },
      },
    }).runOnce();
    expect(await outboxRow(row.id)).toMatchObject({ status: "DEAD_LETTERED", attempts: 1 });
  });

  it("dead-letters an event type with no handler", async () => {
    const row = await insertTestEvent("test.nobody_handles_this");
    await runner("u").runOnce();
    const current = await outboxRow(row.id);
    expect(current).toMatchObject({ status: "DEAD_LETTERED" });
    expect(current.lastError).toContain("no handler for event type test.nobody_handles_this");
  });
});

describe("dead-letter redrive", () => {
  it("returns only dead letters to PENDING with a fresh cycle, audits it, and keeps history", async () => {
    let healthy = false;
    const flaky: EventHandlerRegistry = {
      "test.flaky": async () => {
        if (!healthy) throw new Error("not yet");
        return { status: "processed" };
      },
    };
    const row = await insertTestEvent("test.flaky");
    await runner("f", { handlers: flaky, retry: { ...retry, maxAttempts: 1 } }).runOnce();
    expect((await outboxRow(row.id)).status).toBe("DEAD_LETTERED");
    expect((await store.listDeadLetters()).map((r) => r.id)).toContain(row.id);

    const processed = await acceptHris();
    await runner("w").runOnce();

    const result = await store.redrive({
      eventIds: [row.id, processed.outboxId, randomUUID()],
      actor: "ops:test",
      reason: "downstream fixed",
    });
    expect(result.redriven).toEqual([row.id]);
    expect(result.skipped).toHaveLength(2);
    expect((await outboxRow(processed.outboxId)).status).toBe("PROCESSED"); // untouched

    const redriven = await outboxRow(row.id);
    expect(redriven).toMatchObject({
      status: "PENDING",
      cycleAttempts: 0,
      attempts: 1,
      redriveCount: 1,
      deadLetteredAt: null,
    });
    const [audit] = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "outbox.event.redriven"),
          sql`${auditEvents.payload}->>'outboxEventId' = ${row.id}`,
        ),
      );
    expect(audit).toMatchObject({ actor: "ops:test", payload: { reason: "downstream fixed" } });

    healthy = true;
    expect((await runner("f2", { handlers: flaky }).runOnce()).succeeded).toBe(1);
    expect(await outboxRow(row.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    expect((await store.listAttempts(row.id)).map((a) => [a.attemptNumber, a.outcome])).toEqual([
      [1, "DEAD_LETTERED"],
      [2, "SUCCEEDED"],
    ]);
  });

  it("redriving the same dead letter twice concurrently redrives it once", async () => {
    const row = await insertTestEvent("test.nobody_handles_this");
    await runner("u").runOnce();
    const results = await Promise.all(
      [1, 2].map(() => store.redrive({ eventIds: [row.id], actor: "ops", reason: "retry" })),
    );
    expect(results.map((r) => r.redriven.length).sort()).toEqual([0, 1]);
    expect((await outboxRow(row.id)).redriveCount).toBe(1);
  });
});

describe("reused active workflow", () => {
  it("acknowledges the linked event without restarting or re-running the workflow", async () => {
    const first = await acceptHris();
    const second = await acceptHris(
      newOfferSignedEvent({ employeeId: first.event.employeeId, employee: first.event.employee }),
    );
    expect(second).toMatchObject({ workflowId: first.workflowId, workflowCreated: false });

    await runner("w").runOnce();
    const h = await workflowHistory(first.workflowId);
    expect(h.workflow).toMatchObject({ state: "ACCESS_PLANNING", version: 2 });
    expect(h.audit.filter((e) => e.eventType === "workflow.transitioned")).toHaveLength(1);
    expect(await store.listAttempts(second.outboxId)).toMatchObject([
      { outcome: "SUCCEEDED", detail: { status: "skipped", reason: "ACTIVE_WORKFLOW_REUSED" } },
    ]);

    // Later: the workflow has moved on; another linked event must not pull it back or restart it.
    await workflows.transition({
      workflowId: first.workflowId,
      to: "POLICY_REVIEW",
      expectedVersion: 2,
      actor: "test",
    });
    const third = await acceptHris(
      newOfferSignedEvent({ employeeId: first.event.employeeId, employee: first.event.employee }),
    );
    await runner("w").runOnce();
    const after = await workflowHistory(first.workflowId);
    expect(after.workflow).toMatchObject({ state: "POLICY_REVIEW", version: 3 });
    expect(
      after.steps.filter((s: { stepKey: string }) => s.stepKey === "ACCESS_PLANNING"),
    ).toHaveLength(1);
    expect((await outboxRow(third.outboxId)).status).toBe("PROCESSED");
  });

  it("does not start a workflow that was failed before the worker ran", async () => {
    const accepted = await acceptHris();
    await workflows.transition({
      workflowId: accepted.workflowId,
      to: "FAILED",
      expectedVersion: 1,
      actor: "test",
      reason: "offer withdrawn",
    });
    await runner("w").runOnce();
    expect((await workflowHistory(accepted.workflowId)).workflow.state).toBe("FAILED");
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { outcome: "SUCCEEDED", detail: { status: "skipped", reason: "WORKFLOW_NOT_IN_RECEIVED" } },
    ]);
  });
});

describe("idempotent transitions (WorkflowService)", () => {
  it("a replayed key returns the current workflow and writes nothing, even with a stale version", async () => {
    const accepted = await acceptHris();
    await runner("w").runOnce();
    const replay = await workflows.transition({
      workflowId: accepted.workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: 1,
      actor: "replay",
      idempotencyKey: workflowStartKey(accepted.workflowId),
    });
    expect(replay).toMatchObject({ state: "ACCESS_PLANNING", version: 2 });
    expectStartedOnce(await workflowHistory(accepted.workflowId));
    const steps = await handle.db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, accepted.workflowId));
    expect(steps).toHaveLength(2);
  });

  it("rejects reusing a key for a different workflow", async () => {
    const a = await acceptHris();
    const b = await acceptHris();
    await runner("w").runOnce();
    await expect(
      workflows.transition({
        workflowId: b.workflowId,
        to: "POLICY_REVIEW",
        expectedVersion: 2,
        actor: "t",
        idempotencyKey: workflowStartKey(a.workflowId),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("concurrent calls with the same key commit exactly one transition", async () => {
    const accepted = await acceptHris();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        workflows.transition({
          workflowId: accepted.workflowId,
          to: "ACCESS_PLANNING",
          expectedVersion: 1,
          actor: "race",
          idempotencyKey: workflowStartKey(accepted.workflowId),
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expectStartedOnce(await workflowHistory(accepted.workflowId));
  });
});
