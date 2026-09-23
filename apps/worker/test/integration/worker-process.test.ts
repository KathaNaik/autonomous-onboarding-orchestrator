import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabase, outboxEvents, type DatabaseHandle } from "@aoo/db";
import {
  createHrisIntakeService,
  createPostgresOutboxStore,
  createWorkflowService,
  type PostgresOutboxStore,
  type WorkflowService,
} from "@aoo/orchestrator";
import type { HrisOfferSignedEvent } from "@aoo/shared";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { killHard, startWorker, waitFor, type WorkerProcess } from "./process.js";

let handle: DatabaseHandle;
let store: PostgresOutboxStore;
let workflows: WorkflowService;
const running: WorkerProcess[] = [];

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  store = createPostgresOutboxStore(handle.db);
  workflows = createWorkflowService(handle.db);
});
afterAll(async () => {
  for (const w of running) if (w.child.exitCode === null) await killHard(w);
  await handle.close();
});

async function spawnWorker(env: Record<string, string> = {}) {
  const w = await startWorker({ DATABASE_URL: inject("databaseUrl"), ...env });
  running.push(w);
  return w;
}

function offerSigned(): HrisOfferSignedEvent {
  const id = randomUUID().slice(0, 8);
  return {
    eventId: `evt-${randomUUID()}`,
    eventType: "offer.signed",
    occurredAt: new Date().toISOString(),
    employeeId: `HRIS-${id}`,
    employee: { firstName: "Worker", lastName: `Test ${id}`, email: `w.${id}@example.com` },
    role: "Software Engineer",
    department: "Engineering",
    managerId: "HRIS-MGR-1",
    offerStatus: "SIGNED",
    candidateStatus: "CLEARED",
  };
}

async function acceptHris() {
  const event = offerSigned();
  const result = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  const [row] = await handle.db
    .select()
    .from(outboxEvents)
    .where(sql`${outboxEvents.payload}->>'hrisEventId' = ${event.eventId}`);
  return { ...result, outboxId: row!.id };
}

const status = async (id: string) =>
  (await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]!.status;

async function expectStartedOnce(workflowId: string) {
  const details = await workflows.getWorkflow(workflowId);
  const audit = await workflows.listAuditEvents(workflowId);
  expect(details?.workflow).toMatchObject({ state: "ACCESS_PLANNING", version: 2 });
  expect(details?.steps.map((s) => s.stepKey)).toEqual(["RECEIVED", "ACCESS_PLANNING"]);
  expect(audit.map((e) => e.eventType)).toEqual(["workflow.created", "workflow.transitioned"]);
}

/** Installs a trigger that parks the matching statement in pg_sleep, to freeze a worker mid-flight. */
async function installSleepTrigger(name: string, table: string, when: string) {
  await handle.db.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(60); RETURN NEW; END $$;
    DROP TRIGGER IF EXISTS ${name} ON ${table};
    CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}();`),
  );
}
async function dropTrigger(name: string, table: string) {
  await handle.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
}
/** Waits until some backend in this database is parked in pg_sleep; returns their pids. */
async function waitForSleepingBackend(): Promise<number[]> {
  let pids: number[] = [];
  await waitFor(
    async () => {
      const res = await handle.db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event = 'PgSleep' AND pid <> pg_backend_pid()`);
      pids = res.rows.map((r) => r.pid);
      return pids.length > 0;
    },
    15_000,
    "worker to block inside the trigger",
  );
  return pids;
}
/**
 * After SIGKILL, PostgreSQL would roll the orphaned transaction back once the sleep ends and it
 * notices the dead socket. Terminating the backend makes that immediate.
 */
async function terminate(pids: number[]) {
  for (const pid of pids) await handle.db.execute(sql`SELECT pg_terminate_backend(${pid})`);
}

describe("worker process", () => {
  it("processes events, reports readiness, logs JSON and shuts down gracefully on SIGTERM", async () => {
    const accepted = await acceptHris();
    const worker = await spawnWorker({ WORKER_ID: "proc-happy" });

    await waitFor(
      async () => (await status(accepted.outboxId)) === "PROCESSED",
      15_000,
      "processing",
    );
    await expectStartedOnce(accepted.workflowId);

    const ready = await worker.health("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready", workerId: "proc-happy", lastPollOk: true });
    expect((ready.body.totals as { succeeded: number }).succeeded).toBeGreaterThanOrEqual(1);
    expect((await worker.health("/live")).status).toBe(200);

    await worker.waitForLog(
      (l) => l.msg === "outbox event processed" && l.eventId === accepted.outboxId,
    );
    const line = worker.logs.find((l) => l.eventId === accepted.outboxId)!;
    expect(line).toMatchObject({
      service: "worker",
      workerId: "proc-happy",
      eventType: "hris.offer_signed.accepted",
      attempt: 1,
      result: "processed",
    });

    worker.child.kill("SIGTERM");
    expect(await worker.exited).toBe(0);
    expect(worker.logs.some((l) => l.msg === "worker stopped")).toBe(true);
  });

  it("two worker processes share the queue without double-processing", async () => {
    const accepted = await Promise.all(Array.from({ length: 20 }, () => acceptHris()));
    const env = { OUTBOX_BATCH_SIZE: "2" };
    const [a, b] = await Promise.all([
      spawnWorker({ ...env, WORKER_ID: "proc-a" }),
      spawnWorker({ ...env, WORKER_ID: "proc-b" }),
    ]);
    const ids = accepted.map((x) => x.outboxId);
    await waitFor(
      async () => {
        const rows = await handle.db
          .select({ status: outboxEvents.status })
          .from(outboxEvents)
          .where(inArray(outboxEvents.id, ids));
        return rows.every((r) => r.status === "PROCESSED");
      },
      30_000,
      "all events processed",
    );
    for (const id of ids) {
      const attempts = await store.listAttempts(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe("SUCCEEDED");
    }
    for (const x of accepted) await expectStartedOnce(x.workflowId);
    a.child.kill("SIGTERM");
    b.child.kill("SIGTERM");
    await Promise.all([a.exited, b.exited]);
  });

  it("recovers from a SIGKILL in the middle of the workflow transition", async () => {
    const accepted = await acceptHris();
    await installSleepTrigger(
      "test_freeze_transition",
      "workflow_steps",
      `NEW.workflow_id = '${accepted.workflowId}' AND NEW.step_key = 'ACCESS_PLANNING'`,
    );
    const crashy = await spawnWorker({ WORKER_ID: "proc-crash-1", OUTBOX_LEASE_MS: "1000" });
    try {
      const pids = await waitForSleepingBackend();
      await killHard(crashy);
      await terminate(pids);
    } finally {
      await dropTrigger("test_freeze_transition", "workflow_steps");
    }

    // The transition rolled back with the dead process; the event is still owed.
    expect((await workflows.getWorkflow(accepted.workflowId))?.workflow).toMatchObject({
      state: "RECEIVED",
      version: 1,
    });
    expect(await status(accepted.outboxId)).toBe("PENDING");

    const rescuer = await spawnWorker({ WORKER_ID: "proc-rescue-1" });
    await waitFor(
      async () => (await status(accepted.outboxId)) === "PROCESSED",
      15_000,
      "recovery",
    );
    await expectStartedOnce(accepted.workflowId);
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { workerId: "proc-crash-1", outcome: "LEASE_EXPIRED" },
      { workerId: "proc-rescue-1", outcome: "SUCCEEDED" },
    ]);
    rescuer.child.kill("SIGTERM");
    await rescuer.exited;
  });

  it("recovers from a SIGKILL after the transition committed but before the ack", async () => {
    const accepted = await acceptHris();
    await installSleepTrigger(
      "test_freeze_ack",
      "outbox_events",
      `NEW.id = '${accepted.outboxId}' AND NEW.status = 'PROCESSED'`,
    );
    const crashy = await spawnWorker({ WORKER_ID: "proc-crash-2", OUTBOX_LEASE_MS: "1000" });
    try {
      const pids = await waitForSleepingBackend();
      await killHard(crashy);
      await terminate(pids);
    } finally {
      await dropTrigger("test_freeze_ack", "outbox_events");
    }

    // The workflow start committed; the acknowledgement did not.
    await expectStartedOnce(accepted.workflowId);
    expect(await status(accepted.outboxId)).toBe("PENDING");

    const rescuer = await spawnWorker({ WORKER_ID: "proc-rescue-2" });
    await waitFor(
      async () => (await status(accepted.outboxId)) === "PROCESSED",
      15_000,
      "recovery",
    );
    await expectStartedOnce(accepted.workflowId); // no duplicate step or audit event
    expect(await store.listAttempts(accepted.outboxId)).toMatchObject([
      { workerId: "proc-crash-2", outcome: "LEASE_EXPIRED" },
      {
        workerId: "proc-rescue-2",
        outcome: "SUCCEEDED",
        detail: { state: "ACCESS_PLANNING", version: 2 },
      },
    ]);
    rescuer.child.kill("SIGTERM");
    await rescuer.exited;
  });

  it("is live but not ready when PostgreSQL is unreachable", async () => {
    const worker = await spawnWorker({
      WORKER_ID: "proc-nodb",
      DATABASE_URL: "postgres://aoo:aoo@127.0.0.1:1/aoo",
    });
    await waitFor(
      async () => (await worker.health("/ready")).body.consecutiveFailures !== 0,
      10_000,
      "a failed poll",
    );
    const ready = await worker.health("/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: "not_ready", lastPollOk: false });
    expect((await worker.health("/live")).status).toBe(200);
    worker.child.kill("SIGTERM");
    expect(await worker.exited).toBe(0);
  });
});

describe("admin CLI", () => {
  const run = promisify(execFile);
  const workerDir = fileURLToPath(new URL("../..", import.meta.url));
  const admin = async (...args: string[]) => {
    const { stdout } = await run(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "src/admin.ts", ...args],
      { cwd: workerDir, env: { ...process.env, DATABASE_URL: inject("databaseUrl") } },
    );
    return JSON.parse(stdout);
  };

  it("lists dead letters and redrives only the requested dead letter, with dry-run", async () => {
    const [dead] = await handle.db
      .insert(outboxEvents)
      .values({
        idempotencyKey: `test:${randomUUID()}`,
        aggregateType: "test",
        aggregateId: randomUUID(),
        eventType: "test.unhandled",
        payload: {},
      })
      .returning();
    const worker = await spawnWorker({ WORKER_ID: "proc-dlq" });
    await waitFor(async () => (await status(dead!.id)) === "DEAD_LETTERED", 15_000, "dead letter");
    worker.child.kill("SIGTERM");
    await worker.exited;

    const listed = await admin("dead-letters");
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: dead!.id, eventType: "test.unhandled", attempts: 1 }),
      ]),
    );

    expect(
      await admin("redrive", "--id", dead!.id, "--reason", "handler deployed", "--dry-run"),
    ).toEqual({
      dryRun: true,
      wouldRedrive: [dead!.id],
    });
    expect(await status(dead!.id)).toBe("DEAD_LETTERED");

    const result = await admin(
      "redrive",
      "--id",
      dead!.id,
      "--reason",
      "handler deployed",
      "--actor",
      "ops:test",
    );
    expect(result).toEqual({ redriven: [dead!.id], skipped: [] });
    expect(await status(dead!.id)).toBe("PENDING");
    // Park it again so later tests' workers do not dead-letter it a second time.
    await handle.db
      .update(outboxEvents)
      .set({ status: "PROCESSED", publishedAt: new Date() })
      .where(eq(outboxEvents.id, dead!.id));

    await expect(admin("redrive", "--id", dead!.id)).rejects.toThrow(); // --reason required
  });
});
