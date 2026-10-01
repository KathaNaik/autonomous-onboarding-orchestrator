import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabase,
  onboardingWorkflows,
  outboxEventAttempts,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import {
  createHrisIntakeService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
  noopLogger,
  type EventHandlerRegistry,
} from "@aoo/orchestrator";
import type { HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { runWorkerBatch } from "../../src/batch.js";
import { createWorkerFunctionHandler, environmentRuntime } from "../../src/serverless.js";
import { SCHEDULE_BODY, WORKER_URL, signQStash, testSigningKeys } from "../qstash-signing.js";

const keys = testSigningKeys();
let handle: DatabaseHandle;
let server: Server;
let base: string;
const silent = pino({ level: "silent" });

beforeAll(async () => {
  handle = createDatabase(inject("databaseUrl"));
  const runtime = environmentRuntime({
    DATABASE_URL: inject("databaseUrl"),
    LOG_LEVEL: "silent",
    WORKER_ID: "vercel-test",
    QSTASH_CURRENT_SIGNING_KEY: keys.current,
    QSTASH_NEXT_SIGNING_KEY: keys.next,
    WORKER_QSTASH_URL: WORKER_URL,
    ONBOARDING_PLAN_RUN_LEASE_MS: "60000",
    ROLE_ACCESS_RUN_LEASE_MS: "60000",
    OUTBOX_BATCH_SIZE: "5",
  });
  const handler = createWorkerFunctionHandler(runtime);
  server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await handle.close();
});
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      last_error = 'parked by test cleanup' WHERE status = 'PENDING'`);
});

const deliver = (signature?: string, body = SCHEDULE_BODY) =>
  fetch(`${base}/api/worker/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== undefined && { "upstash-signature": signature }),
    },
    body,
  });
type RunBody = { claimed: number; [key: string]: unknown };
const json = async (res: Response) => (await res.json()) as RunBody;
const signed = (overrides: Partial<Parameters<typeof signQStash>[0]> = {}) =>
  signQStash({ key: keys.current, url: WORKER_URL, body: SCHEDULE_BODY, ...overrides });

function offerSigned(): HrisOfferSignedEvent {
  const id = randomUUID().slice(0, 8);
  return {
    eventId: `evt-${randomUUID()}`,
    eventType: "offer.signed",
    occurredAt: new Date().toISOString(),
    employeeId: `HRIS-${id}`,
    employee: { firstName: "Queued", lastName: `Hire ${id}`, email: `q.${id}@example.com` },
    role: "Software Engineer",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "SOFTWARE_ENGINEER",
    employmentType: "FULL_TIME",
    managerId: "HRIS-MGR-1",
    offerStatus: "SIGNED",
    candidateStatus: "CLEARED",
  };
}

/** Business state that any worker run would change: counts and versions, not timestamps. */
async function snapshot() {
  const { rows } = await handle.db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*)::int FROM outbox_events WHERE status = 'PENDING') AS pending,
      (SELECT count(*)::int FROM outbox_events WHERE lease_token IS NOT NULL) AS leased,
      (SELECT coalesce(sum(attempts), 0)::int FROM outbox_events) AS attempts,
      (SELECT count(*)::int FROM outbox_event_attempts) AS attempt_rows,
      (SELECT count(*)::int FROM audit_events) AS audits,
      (SELECT coalesce(sum(version), 0)::int FROM onboarding_workflows) AS versions,
      (SELECT count(*)::int FROM external_operations) AS operations`);
  return rows[0];
}

async function workflowState(workflowId: string) {
  const [wf] = await handle.db
    .select()
    .from(onboardingWorkflows)
    .where(eq(onboardingWorkflows.id, workflowId));
  return wf!;
}

describe("(M10) signed serverless worker against PostgreSQL", () => {
  it("unauthorized invocations make zero claims and zero business mutations", async () => {
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(
      offerSigned(),
    );
    const before = await snapshot();
    for (const signature of [
      undefined,
      "garbage.signature.value",
      signQStash({ key: testSigningKeys().current, url: WORKER_URL, body: SCHEDULE_BODY }),
      signed({ now: Date.now() - 3_600_000, expiresInSeconds: 60 }),
      signed({ url: "https://elsewhere.test/api/worker/run" }),
    ]) {
      expect((await deliver(signature)).status).toBe(401);
    }
    expect((await deliver(signed(), '{"source":"forged"}')).status).toBe(401);
    expect(await snapshot()).toEqual(before);
    expect((await workflowState(workflowId)).state).toBe("RECEIVED");
  });

  it("off-hours: a signed HRIS event waits durably; the next scheduled invocation resumes it", async () => {
    // 17:30, worker schedule inactive: intake commits workflow + outbox; nothing processes it.
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(
      offerSigned(),
    );
    expect((await workflowState(workflowId)).state).toBe("RECEIVED");
    const [pending] = await handle.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.aggregateId} = ${workflowId}`);
    expect(pending).toMatchObject({ status: "PENDING", attempts: 0 });
    // 09:00 next business period: QStash delivers a signed wake.
    const res = await deliver(signed());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ status: "ok", stoppedBy: "IDLE" });
    expect(body.claimed).toBeGreaterThanOrEqual(1);
    expect((await workflowState(workflowId)).state).toBe("ACCESS_PLANNING");
  });

  it("duplicate concurrent deliveries of the same signed wake are harmless", async () => {
    const intake = createHrisIntakeService(handle.db);
    const ids = await Promise.all([1, 2, 3].map(() => intake.acceptOfferSigned(offerSigned())));
    const signature = signed();
    const [a, b] = await Promise.all([deliver(signature), deliver(signature)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ra, rb] = [await json(a), await json(b)];
    // Each event claimed by exactly one invocation: 3 HRIS starts + the 3 access-planning
    // requests they write (acknowledged as disabled here; ROLE_ACCESS_AGENT_ENABLED is off).
    expect(ra.claimed + rb.claimed).toBe(6);
    for (const { workflowId } of ids) {
      expect(await workflowState(workflowId)).toMatchObject({
        state: "ACCESS_PLANNING",
        version: 2,
      });
      const transitions = await handle.db
        .select()
        .from(auditEvents)
        .where(
          sql`${auditEvents.workflowId} = ${workflowId} AND ${auditEvents.eventType} = 'workflow.transitioned'`,
        );
      expect(transitions).toHaveLength(1);
      const events = await handle.db
        .select()
        .from(outboxEvents)
        .where(sql`${outboxEvents.aggregateId} = ${workflowId}`);
      expect(events.map((e) => [e.eventType, e.status, e.attempts]).sort()).toEqual([
        ["access.planning.requested", "PROCESSED", 1],
        ["hris.offer_signed.accepted", "PROCESSED", 1],
      ]);
    }
  });

  it("a killed invocation's leased work is recovered by the next invocation", async () => {
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(
      offerSigned(),
    );
    // The function instance is terminated right after claiming (lease left behind).
    await createPostgresOutboxStore(handle.db).claim({
      workerId: "terminated-instance",
      batchSize: 10,
      leaseMs: 30_000,
    });
    expect((await json(await deliver(signed()))).claimed).toBe(0); // live lease: untouched
    await handle.db.execute(
      sql`UPDATE outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE aggregate_id = ${workflowId} AND lease_token IS NOT NULL`,
    );
    // The recovered start, then (same invocation, chained) the access-planning request it wrote.
    expect((await json(await deliver(signed()))).claimed).toBe(2);
    expect((await workflowState(workflowId)).state).toBe("ACCESS_PLANNING");
    const attempts = await handle.db
      .select()
      .from(outboxEventAttempts)
      .innerJoin(outboxEvents, eq(outboxEvents.id, outboxEventAttempts.outboxEventId))
      .where(
        and(
          eq(outboxEvents.aggregateId, workflowId),
          eq(outboxEvents.eventType, "hris.offer_signed.accepted"),
        ),
      )
      .orderBy(outboxEventAttempts.attemptNumber);
    expect(attempts.map((r) => r.outbox_event_attempts.outcome)).toEqual([
      "LEASE_EXPIRED",
      "SUCCEEDED",
    ]);
  });
});

describe("(M10) runWorkerBatch", () => {
  const store = () => createPostgresOutboxStore(handle.db);
  const insert = (eventType: string, aggregateId = randomUUID()) =>
    handle.db
      .insert(outboxEvents)
      .values({
        idempotencyKey: `test:${randomUUID()}`,
        aggregateType: "test",
        aggregateId,
        eventType,
        payload: {},
      })
      .returning()
      .then((r) => r[0]!);
  const servicesWith = (handlers: EventHandlerRegistry, batchSize = 5) => ({
    runner: createOutboxRunner(store(), {
      workerId: "batch-test",
      batchSize,
      leaseMs: 30_000,
      retry: { maxAttempts: 3, backoffBaseMs: 60_000, backoffMaxMs: 60_000 },
      handlers,
      logger: noopLogger,
      random: () => 0,
    }),
    coordinator: { enqueueDueWakes: async () => ({ enqueued: 0 }) },
    onboardingPlans: undefined,
  });

  it("drains an immediate chain (A creates B creates C) in one invocation", async () => {
    const chain = randomUUID();
    const handlers: EventHandlerRegistry = {
      "test.chain_a": async () => (await insert("test.chain_b", chain), { status: "processed" }),
      "test.chain_b": async () => (await insert("test.chain_c", chain), { status: "processed" }),
      "test.chain_c": async () => ({ status: "processed" }),
    };
    await insert("test.chain_a", chain);
    const result = await runWorkerBatch(servicesWith(handlers) as never, silent, {
      maxEvents: 100,
      deadlineMs: 60_000,
    });
    expect(result).toMatchObject({ claimed: 3, succeeded: 3, stoppedBy: "IDLE" });
    expect(result.batches).toBe(4); // A, B, C, then an empty poll
    const rows = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, chain));
    expect(rows.every((r) => r.status === "PROCESSED")).toBe(true);
  });

  it("does not wait for delayed work: a retry with backoff stays for a later invocation", async () => {
    const failing = await insert("test.fails_once");
    let calls = 0;
    const result = await runWorkerBatch(
      servicesWith({
        "test.fails_once": async () => {
          calls += 1;
          throw new Error("transient");
        },
      }) as never,
      silent,
      { maxEvents: 100, deadlineMs: 60_000 },
    );
    expect(result).toMatchObject({ claimed: 1, retried: 1, stoppedBy: "IDLE" });
    expect(calls).toBe(1);
    const [row] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, failing.id));
    expect(row).toMatchObject({ status: "PENDING", leaseToken: null });
  });

  it("stops claiming at the deadline and at the event budget; the next invocation resumes", async () => {
    const group = randomUUID();
    for (let i = 0; i < 6; i++) await insert("test.noop", group);
    const handlers: EventHandlerRegistry = { "test.noop": async () => ({ status: "processed" }) };
    // A clock that passes the deadline after the first batch.
    let t = 0;
    const deadline = await runWorkerBatch(servicesWith(handlers, 2) as never, silent, {
      maxEvents: 100,
      deadlineMs: 1_000,
      now: () => (t += 600),
    });
    expect(deadline).toMatchObject({ claimed: 2, stoppedBy: "DEADLINE" });
    const budget = await runWorkerBatch(servicesWith(handlers, 2) as never, silent, {
      maxEvents: 3,
      deadlineMs: 60_000,
    });
    expect(budget).toMatchObject({ claimed: 3, stoppedBy: "MAX_EVENTS" });
    const rest = await runWorkerBatch(servicesWith(handlers, 2) as never, silent, {
      maxEvents: 100,
      deadlineMs: 60_000,
    });
    expect(rest).toMatchObject({ claimed: 1, stoppedBy: "IDLE" });
    const rows = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, group));
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill("PROCESSED"));
  });

  it("an unexpected workflow service failure is reported as ERROR, not thrown", async () => {
    const broken = {
      runner: { runOnce: async () => Promise.reject(new Error("database unavailable")) },
      coordinator: { enqueueDueWakes: async () => Promise.reject(new Error("db down")) },
      onboardingPlans: undefined,
    };
    const result = await runWorkerBatch(broken as never, silent, {
      maxEvents: 5,
      deadlineMs: 1000,
    });
    expect(result).toMatchObject({ stoppedBy: "ERROR", claimed: 0, sweep: { failed: true } });
    expect(createWorkflowService).toBeTypeOf("function");
  });
});
