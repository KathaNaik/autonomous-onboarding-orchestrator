import { approvalCallbackEvents, createDatabase, outboxEvents, type DatabaseHandle } from "@aoo/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { callbackEnv, callbackPayload, signedCallback } from "../callback-helpers.js";
import { TEST_SECRET, testConfig } from "../helpers.js";

let app: FastifyInstance;
let handle: DatabaseHandle;
const config = () => testConfig({ ...callbackEnv, DATABASE_URL: inject("databaseUrl") });

beforeAll(async () => {
  app = await buildApp(config());
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const post = (target: FastifyInstance, req: { body: string; headers: Record<string, string> }) =>
  target.inject({
    method: "POST",
    url: "/webhooks/servicenow/approvals",
    payload: req.body,
    headers: req.headers,
  });

async function stored(eventId: string) {
  const rows = await handle.db
    .select()
    .from(approvalCallbackEvents)
    .where(eq(approvalCallbackEvents.eventId, eventId));
  const outbox = rows[0]
    ? await handle.db
        .select()
        .from(outboxEvents)
        .where(sql`${outboxEvents.payload}->>'callbackEventId' = ${rows[0].id}`)
    : [];
  return { rows, outbox };
}

describe("approval callback endpoint (real PostgreSQL)", () => {
  it("durably records the callback and its verification event before answering 202", async () => {
    const payload = callbackPayload();
    const res = await post(app, signedCallback(payload));
    expect(res.statusCode).toBe(202);
    const { rows, outbox } = await stored(payload.eventId);
    expect(rows).toMatchObject([
      {
        provider: "servicenow",
        externalId: payload.sysId,
        externalReference: payload.number,
        correlationKey: payload.correlationKey,
        claimedState: "approved",
        status: "RECEIVED",
        outcome: null,
      },
    ]);
    expect(outbox).toMatchObject([
      { eventType: "servicenow.approval_callback.received", status: "PENDING" },
    ]);
  });

  it("duplicate and concurrent duplicate deliveries record exactly one event", async () => {
    const req = signedCallback(callbackPayload());
    const eventId = JSON.parse(req.body).eventId as string;
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(app, req)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(10).fill(202));
    expect(responses.filter((r) => !r.json().duplicate)).toHaveLength(1);
    const { rows, outbox } = await stored(eventId);
    expect([rows.length, outbox.length]).toEqual([1, 1]);
  });

  it("replay after an API restart is recognized as a duplicate", async () => {
    const req = signedCallback(callbackPayload());
    await post(app, req);
    const restarted = await buildApp(config());
    try {
      expect((await post(restarted, req)).json()).toMatchObject({ duplicate: true });
    } finally {
      await restarted.close();
    }
    expect((await stored(JSON.parse(req.body).eventId)).rows).toHaveLength(1);
  });

  it("stores nothing for bad auth, stale signatures, bad payloads or unexpected sources", async () => {
    const cases = [
      signedCallback(callbackPayload(), { secret: TEST_SECRET }),
      signedCallback(callbackPayload(), { timestamp: Date.now() - 3_600_000 }),
      signedCallback(callbackPayload({ sysId: "nope" })),
      signedCallback(callbackPayload({ instance: "dev999999" })),
    ];
    for (const req of cases) {
      const res = await post(app, req);
      expect([400, 401, 422]).toContain(res.statusCode);
      expect((await stored(JSON.parse(req.body).eventId)).rows).toHaveLength(0);
    }
  });

  it("a reused event id with different content is refused (409) and the original is untouched", async () => {
    const payload = callbackPayload();
    await post(app, signedCallback(payload));
    const res = await post(app, signedCallback({ ...payload, number: "OAR0000001" }));
    expect(res.statusCode).toBe(409);
    expect((await stored(payload.eventId)).rows[0]).toMatchObject({
      externalReference: payload.number,
    });
  });

  it("persistence failure → 500 and nothing recorded; the retried delivery then succeeds", async () => {
    const payload = callbackPayload();
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_callback_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'servicenow.approval_callback.received' THEN RAISE EXCEPTION 'simulated'; END IF; RETURN NEW; END $$;
      DROP TRIGGER IF EXISTS test_fail_callback_outbox ON outbox_events;
      CREATE TRIGGER test_fail_callback_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION test_fail_callback_outbox();`),
    );
    try {
      const res = await post(app, signedCallback(payload));
      expect(res.statusCode).toBe(500);
      expect((await stored(payload.eventId)).rows).toHaveLength(0);
    } finally {
      await handle.db.execute(
        sql`DROP TRIGGER IF EXISTS test_fail_callback_outbox ON outbox_events`,
      );
    }
    expect((await post(app, signedCallback(payload))).json()).toMatchObject({ duplicate: false });
    expect((await stored(payload.eventId)).rows).toHaveLength(1);
  });

  it("stores identifiers only: no secret, signature, headers or employee data", async () => {
    const payload = callbackPayload({
      employeeName: "Jane Secret-Employee",
      ssn: "123-45-6789",
      email: "jane@corp.example",
    });
    const req = signedCallback(payload);
    await post(app, {
      ...req,
      headers: { ...req.headers, authorization: "Bearer leaked-token", cookie: "JSESSIONID=abc" },
    });
    const { rows, outbox } = await stored(payload.eventId);
    const text = JSON.stringify({ rows, outbox });
    for (const secret of [
      callbackEnv.SERVICENOW_CALLBACK_SECRET,
      req.headers["x-aoo-signature"],
      "leaked-token",
      "JSESSIONID",
      "Jane Secret-Employee",
      "123-45-6789",
      "jane@corp.example",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
