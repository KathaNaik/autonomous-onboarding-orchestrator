import { describe, expect, it, vi } from "vitest";
import { PermanentEventError, type EventHandler } from "../src/events/types.js";
import { createOutboxRunner } from "../src/outbox/runner.js";
import {
  LeaseLostError,
  type ClaimedEvent,
  type FailureDisposition,
  type OutboxStore,
} from "../src/outbox/store.js";

function claimOf(overrides: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: "evt-1",
    eventType: "test.event",
    payload: { a: 1 },
    correlationId: "corr",
    aggregateType: "onboarding_workflow",
    aggregateId: "wf-1",
    attempt: 1,
    cycleAttempt: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    ...overrides,
  };
}

function fakeStore(claims: ClaimedEvent[]) {
  const failures: Array<[string, FailureDisposition]> = [];
  const completed: string[] = [];
  const store: OutboxStore = {
    claim: vi.fn(async () => claims),
    complete: vi.fn(async (c) => {
      completed.push(c.id);
    }),
    fail: vi.fn(async (c, d) => {
      failures.push([c.id, d]);
    }),
  };
  return { store, failures, completed };
}

const retry = { maxAttempts: 3, backoffBaseMs: 100, backoffMaxMs: 10_000 };
const runner = (store: OutboxStore, handler: EventHandler) =>
  createOutboxRunner(store, {
    workerId: "w1",
    batchSize: 10,
    leaseMs: 30_000,
    retry,
    handlers: { "test.event": handler },
    random: () => 0,
  });

describe("outbox runner", () => {
  it("passes a transport-free envelope to the handler and completes on success", async () => {
    const { store, completed } = fakeStore([claimOf({ cycleAttempt: 2, attempt: 5 })]);
    const handler = vi.fn<EventHandler>(async () => ({ status: "processed" }));
    const summary = await runner(store, handler).runOnce();

    expect(handler).toHaveBeenCalledWith(
      {
        id: "evt-1",
        type: "test.event",
        payload: { a: 1 },
        correlationId: "corr",
        aggregateType: "onboarding_workflow",
        aggregateId: "wf-1",
        deliveryAttempt: 2,
      },
      expect.anything(),
    );
    expect(completed).toEqual(["evt-1"]);
    expect(summary).toEqual({
      claimed: 1,
      succeeded: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
  });

  it("schedules a retry with exponential backoff for a transient failure", async () => {
    const { store, failures } = fakeStore([claimOf({ cycleAttempt: 2 })]);
    const summary = await runner(store, async () => {
      throw Object.assign(new Error("db timeout"), { code: "ETIMEDOUT" });
    }).runOnce();

    expect(summary.retried).toBe(1);
    expect(failures).toHaveLength(1);
    const [, d] = failures[0]!;
    expect(d.deadLetter).toBe(false);
    expect(d.retryDelayMs).toBe(100); // cap = 100 * 2^(2-1) = 200, random 0 → 200/2
    expect(d.error).toMatchObject({ name: "Error", message: "db timeout", code: "ETIMEDOUT" });
  });

  it("dead-letters when the retry limit is reached", async () => {
    const { store, failures } = fakeStore([claimOf({ cycleAttempt: 3 })]);
    const summary = await runner(store, async () => {
      throw new Error("still broken");
    }).runOnce();
    expect(summary.deadLettered).toBe(1);
    expect(failures[0]![1]).toMatchObject({ deadLetter: true });
  });

  it("dead-letters a permanent error on the first attempt", async () => {
    const { store, failures } = fakeStore([claimOf()]);
    await runner(store, async () => {
      throw new PermanentEventError("bad payload");
    }).runOnce();
    expect(failures[0]![1]).toMatchObject({
      deadLetter: true,
      error: { name: "PermanentEventError", message: "bad payload" },
    });
  });

  it("dead-letters an event type with no handler", async () => {
    const { store, failures } = fakeStore([claimOf({ eventType: "unknown.type" })]);
    await runner(store, async () => ({ status: "processed" })).runOnce();
    expect(failures[0]![1]).toMatchObject({ deadLetter: true });
    expect(failures[0]![1].error.message).toContain("no handler");
  });

  it("records non-Error throwables", async () => {
    const { store, failures } = fakeStore([claimOf()]);
    await runner(store, async () => {
      throw "boom";
    }).runOnce();
    expect(failures[0]![1].error).toEqual({ name: "NonError", message: "boom" });
  });

  it("discards the result without failing the event when the lease was lost", async () => {
    const { store } = fakeStore([claimOf()]);
    vi.mocked(store.complete).mockRejectedValue(new LeaseLostError("evt-1", "lease-1"));
    const summary = await runner(store, async () => ({ status: "processed" })).runOnce();
    expect(summary).toMatchObject({ succeeded: 0, leaseLost: 1 });
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("processes a batch concurrently and isolates failures per event", async () => {
    const { store, completed, failures } = fakeStore([
      claimOf({ id: "a", leaseToken: "la" }),
      claimOf({ id: "b", leaseToken: "lb" }),
      claimOf({ id: "c", leaseToken: "lc" }),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const summary = await runner(store, async (e) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      if (e.id === "b") throw new Error("b failed");
      return { status: "processed" };
    }).runOnce();

    expect(maxInFlight).toBe(3);
    expect(completed.sort()).toEqual(["a", "c"]);
    expect(failures.map(([id]) => id)).toEqual(["b"]);
    expect(summary).toMatchObject({ claimed: 3, succeeded: 2, retried: 1 });
  });

  it("returns an empty summary when nothing is claimable", async () => {
    const { store } = fakeStore([]);
    expect(await runner(store, async () => ({ status: "processed" })).runOnce()).toEqual({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
  });
});

describe("error details", () => {
  it("keeps the cause chain and codes of wrapped errors", async () => {
    const { store, failures } = fakeStore([claimOf()]);
    const pgError = Object.assign(new Error("simulated downstream outage"), { code: "P0001" });
    await runner(store, async () => {
      throw new Error("Failed query: insert into workflow_steps", { cause: pgError });
    }).runOnce();
    expect(failures[0]![1].error).toMatchObject({
      message: "Failed query: insert into workflow_steps",
      cause: { message: "simulated downstream outage", code: "P0001" },
    });
  });
});
