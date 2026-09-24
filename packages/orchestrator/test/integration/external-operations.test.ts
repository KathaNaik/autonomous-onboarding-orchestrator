import {
  auditEvents,
  createDatabase,
  externalOperations,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExternalOperationError,
  createEventHandlers,
  createExternalOperationService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createWorkflowService,
  type EventLogger,
  type ExternalOperationService,
} from "../../src/index.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newEmployee, sleep } from "./helpers.js";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(() => handle.close());
// Park anything left claimable so each test owns the outbox queue.
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE status = 'PENDING'`);
});

const LEASE = { ownerId: "worker-a", leaseMs: 30_000 };
const fastReconcile = { attempts: 3, delayMs: 10 };

function setup(
  fake = new FakeServiceNow(),
  extra: { logger?: EventLogger; db?: DatabaseHandle } = {},
) {
  const service = createExternalOperationService((extra.db ?? handle).db, {
    servicenow: fake,
    reconcile: fastReconcile,
    correlationPrefix: "aoo-test-oar-",
    ...(extra.logger && { logger: extra.logger }),
  });
  return { fake, service };
}

async function newWorkflowId() {
  const wf = await createWorkflowService(handle.db).createWorkflow({
    employee: newEmployee(),
    actor: "test",
  });
  return wf.id;
}

async function request(service: ExternalOperationService, overrides: Record<string, string> = {}) {
  const workflowId = overrides.workflowId ?? (await newWorkflowId());
  const { operation } = await service.requestServiceNowAccessRequest({
    workflowId,
    employeeId: "TEST-EMP-M4B-001",
    resourceId: "test:resource:github-team",
    requestedEntitlement: "member",
    agentReason: "Synthetic: role requires the platform team",
    policyDecision: "pending",
    actor: "test",
    ...overrides,
  });
  return operation;
}

const op = async (id: string) =>
  (await handle.db.select().from(externalOperations).where(eq(externalOperations.id, id)))[0]!;

const expectError = async (p: Promise<unknown>, code: string, retryable: boolean) => {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ExternalOperationError);
  expect(err).toMatchObject({ code, retryable });
  return err as ExternalOperationError;
};

describe("normal creation and repetition", () => {
  it("creates one ticket, verifies it by read-back, and records ids, attempts and audit", async () => {
    const { fake, service } = setup();
    const operation = await request(service);
    expect(operation).toMatchObject({ status: "PENDING", attempts: 0, provider: "servicenow" });

    const result = await service.execute(operation.id, LEASE);
    expect(result).toMatchObject({ status: "SUCCEEDED", via: "created" });
    expect(fake.posts).toBe(1);
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);

    const row = await op(operation.id);
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      externalId: result.externalId,
      externalReference: result.externalReference,
      attempts: 1,
      ownerToken: null,
      lastError: null,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
    const audit = await handle.db
      .select({ eventType: auditEvents.eventType })
      .from(auditEvents)
      .where(sql`${auditEvents.payload}->>'operationId' = ${operation.id}`);
    expect(audit.map((a) => a.eventType).sort()).toEqual([
      "external_operation.requested",
      "external_operation.succeeded",
    ]);
  });

  it("repeated execution returns the same ticket without contacting the provider", async () => {
    const { fake, service } = setup();
    const operation = await request(service);
    const first = await service.execute(operation.id, LEASE);
    const queriesAfterFirst = fake.queries;
    const again = await service.execute(operation.id, LEASE);
    expect(again).toMatchObject({ via: "already_succeeded", externalId: first.externalId });
    expect([fake.posts, fake.queries]).toEqual([1, queriesAfterFirst]);
  });

  it("requesting the same logical operation twice yields one operation and one outbox event", async () => {
    const { service } = setup();
    const workflowId = await newWorkflowId();
    const a = await request(service, { workflowId });
    const b = await service.requestServiceNowAccessRequest({
      workflowId,
      employeeId: "TEST-EMP-M4B-001",
      resourceId: "test:resource:github-team",
      requestedEntitlement: "member",
      agentReason: "Synthetic: role requires the platform team",
      policyDecision: "pending",
      actor: "test",
    });
    expect(b).toMatchObject({ created: false, operation: { id: a.id } });
    const events = await handle.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${a.id}`);
    expect(events).toHaveLength(1);
    await expectError(
      service.requestServiceNowAccessRequest({
        workflowId,
        employeeId: "TEST-EMP-M4B-001",
        resourceId: "test:resource:github-team",
        requestedEntitlement: "member",
        agentReason: "different reason",
        policyDecision: "pending",
        actor: "test",
      }),
      "IDEMPOTENCY_CONFLICT",
      false,
    );
  });
});

describe("concurrency", () => {
  it("two concurrent creators (separate pools) produce exactly one POST and one ticket", async () => {
    let release!: () => void;
    const fake = new FakeServiceNow();
    fake.createBehaviors.push({ hold: new Promise<void>((r) => (release = r)) });
    const other = createDatabase(inject("databaseUrl"));
    try {
      const a = setup(fake);
      const b = setup(fake, { db: other });
      const operation = await request(a.service);
      const pA = a.service.execute(operation.id, { ownerId: "worker-a", leaseMs: 30_000 });
      await sleep(50);
      const pB = b.service.execute(operation.id, { ownerId: "worker-b", leaseMs: 30_000 });
      const bResult = await pB.then(
        () => "ok",
        (e: ExternalOperationError) => e.code,
      );
      release();
      await expect(pA).resolves.toMatchObject({ status: "SUCCEEDED", via: "created" });
      expect(bResult).toBe("BUSY");
      expect(fake.posts).toBe(1);
      expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
      await expect(b.service.execute(operation.id, LEASE)).resolves.toMatchObject({
        via: "already_succeeded",
      });
    } finally {
      await other.close();
    }
  });

  it("a stale owner cannot overwrite an operation another worker completed", async () => {
    let release!: () => void;
    const fake = new FakeServiceNow();
    fake.createBehaviors.push({ hold: new Promise<void>((r) => (release = r)) }, "ok");
    const { service } = setup(fake);
    const operation = await request(service);

    const stale = service.execute(operation.id, { ownerId: "stale", leaseMs: 300 }).then(
      (v) => v,
      (e) => e,
    );
    await sleep(400); // stale owner's lease expires while its POST is "in flight"
    const fresh = await service.execute(operation.id, { ownerId: "fresh", leaseMs: 30_000 });
    expect(fresh).toMatchObject({ status: "SUCCEEDED", via: "created" });
    release(); // the stale POST now hits the unique correlation_key → 403 → reconcile → fenced write

    const staleOutcome = await stale;
    expect(staleOutcome).toBeInstanceOf(ExternalOperationError);
    expect(staleOutcome).toMatchObject({ code: "OWNERSHIP_LOST", retryable: true });
    expect(await op(operation.id)).toMatchObject({
      status: "SUCCEEDED",
      externalId: fresh.externalId,
    });
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
  });
});

describe("stale owner while a new owner holds the operation", () => {
  it("the stale owner's results are rejected by the owner token; the live owner reconciles its ticket", async () => {
    let releaseStale!: () => void;
    let releaseFresh!: () => void;
    const fake = new FakeServiceNow();
    fake.createBehaviors.push(
      { hold: new Promise<void>((r) => (releaseStale = r)) },
      { hold: new Promise<void>((r) => (releaseFresh = r)) },
    );
    const { service } = setup(fake);
    const operation = await request(service);

    const stale = service.execute(operation.id, { ownerId: "stale", leaseMs: 300 }).then(
      (v) => v,
      (e) => e,
    );
    await sleep(400); // stale lease expired; its POST is still in flight
    const fresh = service.execute(operation.id, { ownerId: "fresh", leaseMs: 30_000 });
    await sleep(100); // fresh now owns the operation (IN_PROGRESS, live lease) and is POSTing

    releaseStale(); // stale POST lands first and creates the record, then tries to record it
    expect(await stale).toMatchObject({ code: "OWNERSHIP_LOST", retryable: true });
    const whileFreshOwns = await op(operation.id);
    expect(whileFreshOwns).toMatchObject({
      status: "IN_PROGRESS",
      ownerId: "fresh",
      externalId: null,
    });

    releaseFresh(); // fresh POST hits the unique key → reconciles the stale-created record
    await expect(fresh).resolves.toMatchObject({
      status: "SUCCEEDED",
      via: "reconciled_after_unknown",
    });
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
    expect(fake.posts).toBe(2);
  });
});

describe("uncertain outcomes", () => {
  it("provider creates, client loses the response → reconciliation finds it in the same attempt", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("lost-after-create");
    const { service } = setup(fake);
    const operation = await request(service);
    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({
      status: "SUCCEEDED",
      via: "reconciled_after_unknown",
    });
    expect(fake.posts).toBe(1);
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
  });

  it("KEY CASE: created → response lost → not yet visible → retry reconciles → no second POST", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("lost-after-create");
    fake.hideFromNextQueries = 1 + fastReconcile.attempts; // pre-check + the whole bounded reconciliation
    const { service } = setup(fake);
    const operation = await request(service);

    await expectError(service.execute(operation.id, LEASE), "RETRY_LATER", true);
    const unknown = await op(operation.id);
    expect(unknown).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      ownerToken: null,
      externalId: null,
    });
    expect(unknown.lastErrorDetail).toMatchObject({
      category: "OUTCOME_UNKNOWN",
      provider: "servicenow",
    });

    const retry = await service.execute(operation.id, LEASE);
    expect(retry).toMatchObject({ status: "SUCCEEDED", via: "reconciled_after_unknown" });
    expect(fake.posts).toBe(1); // the retry never POSTed
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
    expect(await op(operation.id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
      externalId: retry.externalId,
    });
  });

  it("timeout before the provider received the request → bounded reconciliation, then one clean retry", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("lost-before-receipt");
    const { service } = setup(fake);
    const operation = await request(service);

    await expectError(service.execute(operation.id, LEASE), "RETRY_LATER", true);
    expect(await op(operation.id)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(fake.queries).toBe(1 + fastReconcile.attempts); // pre-check + bounded reconciliation, no second POST
    expect(fake.posts).toBe(1);

    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({ via: "created" });
    expect(fake.posts).toBe(2);
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
  });

  it("process crash after POST but before local persistence → next worker reconciles, no POST", async () => {
    const fake = new FakeServiceNow();
    const { service } = setup(fake);
    const operation = await request(service);
    // The crashed worker had claimed the operation and its POST reached ServiceNow.
    fake.insert(operation.request as never);
    await handle.db.execute(sql`
      UPDATE external_operations SET status = 'IN_PROGRESS', attempts = 1, owner_token = gen_random_uuid(),
        owner_id = 'crashed-worker', owner_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = ${operation.id}`);

    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({
      via: "reconciled_after_unknown",
    });
    expect(fake.posts).toBe(0);
    expect(await op(operation.id)).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("5xx after the provider committed → reconciled; 5xx before → retried once cleanly", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("503-after-create");
    const { service } = setup(fake);
    const a = await request(service);
    await expect(service.execute(a.id, LEASE)).resolves.toMatchObject({
      via: "reconciled_after_unknown",
    });

    fake.createBehaviors.push("503-before-create");
    const b = await request(service);
    await expectError(service.execute(b.id, LEASE), "RETRY_LATER", true);
    expect(await op(b.id)).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      lastErrorDetail: { httpStatus: 503 },
    });
    await expect(service.execute(b.id, LEASE)).resolves.toMatchObject({ via: "created" });
    expect(fake.byKey(b.correlationKey)).toHaveLength(1);
  });

  it("malformed 2xx response is not trusted: success only after reconciliation proves the record", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("malformed-after-create");
    const { service } = setup(fake);
    const operation = await request(service);
    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({
      via: "reconciled_after_unknown",
    });
    expect(fake.posts).toBe(1);
  });

  it("the lease deadline bounds a hung provider call (never outlives the lease)", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("hang-until-abort");
    const { service } = setup(fake);
    const operation = await request(service);
    const started = Date.now();
    await expectError(
      service.execute(operation.id, { ownerId: "w", leaseMs: 500 }),
      "RETRY_LATER",
      true,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(await op(operation.id)).toMatchObject({ status: "OUTCOME_UNKNOWN", ownerToken: null });
  });

  it("connection refused (provably unsent) goes back to PENDING without reconciliation", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("refused");
    const { service } = setup(fake);
    const operation = await request(service);
    await expectError(service.execute(operation.id, LEASE), "RETRY_LATER", true);
    expect(await op(operation.id)).toMatchObject({ status: "PENDING" });
    expect(fake.queries).toBe(1);
  });
});

describe("conflicts and permanent failures", () => {
  it("unique-key rejection because the record already exists → reconciled, no duplicate", async () => {
    const fake = new FakeServiceNow();
    const { service } = setup(fake);
    const operation = await request(service);
    fake.hideFromNextQueries = 1; // pre-check misses it, so we POST and hit the unique constraint
    fake.insert(operation.request as never);
    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({
      via: "reconciled_after_unknown",
    });
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
  });

  it("two provider records for one correlation key → CONFLICT with evidence, no automatic execution", async () => {
    const fake = new FakeServiceNow();
    const { service } = setup(fake);
    const operation = await request(service);
    fake.insert(operation.request as never);
    fake.insert(operation.request as never);
    const err = await expectError(service.execute(operation.id, LEASE), "CONFLICT", false);
    expect(err.category).toBe("CONFLICT");
    const row = await op(operation.id);
    expect(row).toMatchObject({ status: "CONFLICT", ownerToken: null });
    expect((row.evidence as { records: unknown[] }).records).toHaveLength(2);
    await expectError(service.execute(operation.id, LEASE), "STOPPED", false);
    expect(fake.posts).toBe(0);
  });

  it("a provider record that differs from the request (e.g. a dropped field) → CONFLICT, names only", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("drop-agent-reason");
    const { service } = setup(fake);
    const operation = await request(service);
    await expectError(service.execute(operation.id, LEASE), "CONFLICT", false);
    const row = await op(operation.id);
    expect(row.evidence).toMatchObject({ mismatchedFields: ["agentReason"] });
    expect(JSON.stringify(row.evidence)).not.toContain("Synthetic: role requires");
  });

  it("authentication failure → FAILED (not retried); reopen re-enqueues", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("auth");
    const { service } = setup(fake);
    const operation = await request(service);
    await expectError(service.execute(operation.id, LEASE), "FAILED", false);
    expect(await op(operation.id)).toMatchObject({
      status: "FAILED",
      lastErrorDetail: { category: "AUTHENTICATION", httpStatus: 401 },
    });

    await service.reopen(operation.id, { actor: "ops:test", reason: "credentials rotated" });
    expect(await op(operation.id)).toMatchObject({ status: "PENDING" });
    await expect(service.execute(operation.id, LEASE)).resolves.toMatchObject({ via: "created" });
  });

  it("permission failure with no record found after reconciliation → FAILED", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("permission");
    const { service } = setup(fake);
    const operation = await request(service);
    await expectError(service.execute(operation.id, LEASE), "FAILED", false);
    expect(await op(operation.id)).toMatchObject({
      status: "FAILED",
      lastErrorDetail: { category: "PERMISSION", httpStatus: 403 },
    });
    await expectError(
      service
        .reopen(operation.id, { actor: "x", reason: "y" })
        .then(() => service.reopen(operation.id, { actor: "x", reason: "y" })),
      "STOPPED",
      false,
    );
  });
});

describe("sensitive error redaction", () => {
  it("credentials and payload values never reach last_error, detail, logs or the outbox", async () => {
    const leak = [
      "Authorization: Basic YWRtaW46U3VwZXJTZWNyZXQ=",
      "password=SuperSecret123",
      "Cookie: JSESSIONID=deadbeef",
      "https://svc:SuperSecret123@dev1.service-now.com/api/now/table/x?sysparm_query=employee_id=TEST-EMP-M4B-001",
      "employee TEST-EMP-M4B-001 because Synthetic: role requires the platform team",
    ].join(" ");
    const fake = new FakeServiceNow();
    fake.createAccessRequest = async () => {
      fake.posts++;
      throw new Error(leak);
    };
    const lines: unknown[] = [];
    const logger: EventLogger = {
      debug: (o) => lines.push(o),
      info: (o) => lines.push(o),
      warn: (o) => lines.push(o),
      error: (o) => lines.push(o),
    };
    const { service } = setup(fake, { logger });
    const operation = await request(service);

    // Run through the real worker path so the outbox's own error columns are covered too.
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "redaction-test",
      batchSize: 10,
      leaseMs: 30_000,
      retry: { maxAttempts: 5, backoffBaseMs: 10, backoffMaxMs: 10 },
      handlers: createEventHandlers({
        workflows: createWorkflowService(handle.db),
        externalOperations: { service, ownerId: "redaction-test", leaseMs: 30_000 },
      }),
      logger,
    });
    await runner.runOnce();

    const row = await op(operation.id);
    const [outbox] = await handle.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);
    const attempts = await createPostgresOutboxStore(handle.db).listAttempts(outbox!.id);
    const stored = JSON.stringify({
      row: [row.lastError, row.lastErrorDetail],
      outbox: outbox!.lastError,
      attempts,
      lines,
    });

    expect(row.status).toBe("OUTCOME_UNKNOWN");
    for (const secret of [
      "YWRtaW46U3VwZXJTZWNyZXQ=",
      "SuperSecret123",
      "JSESSIONID=deadbeef",
      "TEST-EMP-M4B-001",
      "role requires the platform team",
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(row.lastErrorDetail).toMatchObject({
      provider: "servicenow",
      category: "INTERNAL",
      correlationKey: operation.correlationKey,
    });
  });
});

describe("through the outbox worker", () => {
  it("an enqueued operation is executed by the worker; a transient failure is retried to success", async () => {
    const fake = new FakeServiceNow();
    fake.createBehaviors.push("lost-before-receipt");
    const { service } = setup(fake);
    const operation = await request(service);
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "w1",
      batchSize: 10,
      leaseMs: 30_000,
      retry: { maxAttempts: 5, backoffBaseMs: 20, backoffMaxMs: 20 },
      handlers: createEventHandlers({
        workflows: createWorkflowService(handle.db),
        externalOperations: { service, ownerId: "w1", leaseMs: 30_000 },
      }),
      random: () => 0,
    });
    expect(await runner.runOnce()).toMatchObject({ retried: 1 });
    await sleep(50);
    expect(await runner.runOnce()).toMatchObject({ succeeded: 1 });
    expect(await op(operation.id)).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(fake.byKey(operation.correlationKey)).toHaveLength(1);
    const [outbox] = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, "external_operation.execute"),
          sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`,
        ),
      );
    expect(outbox!.status).toBe("PROCESSED");
  });
});
