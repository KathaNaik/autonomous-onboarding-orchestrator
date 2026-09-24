import { createDatabase, employees, hrisEventReceipts, type DatabaseHandle } from "@aoo/db";
import { createWorkflowService } from "@aoo/orchestrator";
import { PolicyError, policySubjectFromEmployee } from "@aoo/policy";
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

const deliver = (event: unknown) => {
  const req = signedRequest(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/hris",
    payload: req.body,
    headers: req.headers,
  });
};

async function employeeRow(hrisEmployeeId: string) {
  const [row] = await handle.db
    .select()
    .from(employees)
    .where(eq(employees.hrisEmployeeId, hrisEmployeeId));
  return row;
}

const factsOf = (row: Awaited<ReturnType<typeof employeeRow>>) => ({
  departmentCode: row?.departmentCode,
  roleFamilyCode: row?.roleFamilyCode,
  employmentType: row?.employmentType,
  factsHrisEventId: row?.factsHrisEventId,
});

const contractor = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SRE",
  employmentType: "CONTRACTOR",
};

describe("canonical facts at ingestion", () => {
  it("persists the canonical facts exactly as sent, with the event that carried them", async () => {
    const event = offerSignedEvent({
      ...contractor,
      role: "SRE II (contract)",
      department: "Infra",
    });
    expect((await deliver(event)).statusCode).toBe(202);

    expect(factsOf(await employeeRow(event.employeeId))).toEqual({
      ...contractor,
      factsHrisEventId: event.eventId,
    });
    const [receipt] = await handle.db
      .select()
      .from(hrisEventReceipts)
      .where(eq(hrisEventReceipts.eventId, event.eventId));
    // Display text is kept verbatim in the receipt, next to the authoritative codes.
    expect(receipt?.payload).toMatchObject({
      ...contractor,
      role: "SRE II (contract)",
      department: "Infra",
    });
  });

  it.each([
    ["unknown department code", { departmentCode: "LEGAL" }],
    ["unknown role family code", { roleFamilyCode: "DATA_SCIENTIST" }],
    ["unknown employment type", { employmentType: "INTERN" }],
    ["display text instead of a code", { departmentCode: "Engineering" }],
    ["disallowed combination", { departmentCode: "SALES" }],
    ["missing canonical fields", { departmentCode: undefined, roleFamilyCode: undefined }],
  ])("rejects %s with 400 and persists nothing", async (_, patch) => {
    const event = offerSignedEvent(patch);
    const res = await deliver(event);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_PAYLOAD" });
    expect(await employeeRow(event.employeeId)).toBeUndefined();
  });
});

describe("M3A behavior with canonical facts", () => {
  it("leaves facts untouched on duplicate and concurrent duplicate deliveries", async () => {
    const event = offerSignedEvent(contractor);
    const responses = await Promise.all(Array.from({ length: 10 }, () => deliver(event)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(10).fill(202));
    expect(responses.filter((r) => !r.json().duplicate)).toHaveLength(1);
    const row = await employeeRow(event.employeeId);
    expect(factsOf(row)).toEqual({ ...contractor, factsHrisEventId: event.eventId });

    // A later redelivery of the same event is a duplicate: it doesn't rewrite the row.
    expect((await deliver(event)).json()).toMatchObject({ duplicate: true });
    expect((await employeeRow(event.employeeId))?.updatedAt).toEqual(row?.updatedAt);
  });

  it("reuses the active workflow and records the latest event's facts", async () => {
    const first = offerSignedEvent(contractor);
    const second = {
      ...offerSignedEvent({ ...contractor, employmentType: "FULL_TIME" }),
      employeeId: first.employeeId,
      employee: first.employee,
    };
    const a = (await deliver(first)).json();
    const b = (await deliver(second)).json();
    expect(b).toMatchObject({ workflowId: a.workflowId, workflowCreated: false, duplicate: false });
    expect(factsOf(await employeeRow(first.employeeId))).toEqual({
      ...contractor,
      employmentType: "FULL_TIME",
      factsHrisEventId: second.eventId,
    });
  });

  it("writes facts in the intake transaction: a rolled-back event changes nothing", async () => {
    const first = offerSignedEvent(contractor);
    await deliver(first);
    const second = {
      ...offerSignedEvent({ ...contractor, employmentType: "FULL_TIME" }),
      employeeId: first.employeeId,
      employee: first.employee,
    };
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_facts_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'hrisEventId' = '${second.eventId}' THEN
          RAISE EXCEPTION 'simulated outbox failure';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_fail_facts_outbox ON outbox_events;
      CREATE TRIGGER test_fail_facts_outbox BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_facts_outbox();
    `),
    );
    try {
      expect((await deliver(second)).statusCode).toBe(500);
      // The employee upsert ran before the failing outbox insert and was rolled back with it.
      expect(factsOf(await employeeRow(first.employeeId))).toEqual({
        ...contractor,
        factsHrisEventId: first.eventId,
      });
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_fail_facts_outbox ON outbox_events`);
    }
    expect((await deliver(second)).statusCode).toBe(202);
    expect((await employeeRow(first.employeeId))?.employmentType).toBe("FULL_TIME");
  });
});

describe("policy subject from the persisted employee", () => {
  it("converts exactly, without reinterpretation", async () => {
    const event = offerSignedEvent({
      departmentCode: "PRODUCT",
      roleFamilyCode: "PRODUCT_MANAGER",
      employmentType: "FULL_TIME",
      role: "Engineering Manager", // misleading display text is ignored
      department: "Engineering",
    });
    await deliver(event);
    const row = await employeeRow(event.employeeId);
    expect(policySubjectFromEmployee(row!)).toEqual({
      employeeId: event.employeeId,
      department: "PRODUCT",
      roleFamily: "PRODUCT_MANAGER",
      employmentType: "FULL_TIME",
    });
  });

  it("refuses a legacy employee without canonical facts, until HRIS supplies them", async () => {
    // Created outside HRIS intake, like pre-M5C rows: no canonical facts.
    const legacy = offerSignedEvent();
    await createWorkflowService(handle.db).createWorkflow({
      employee: { hrisEmployeeId: legacy.employeeId, ...legacy.employee },
      actor: "legacy-import",
    });
    const row = await employeeRow(legacy.employeeId);
    expect(factsOf(row)).toEqual({
      departmentCode: null,
      roleFamilyCode: null,
      employmentType: null,
      factsHrisEventId: null,
    });
    const err = (() => {
      try {
        policySubjectFromEmployee(row!);
      } catch (e) {
        return e as PolicyError;
      }
      throw new Error("expected INCOMPLETE_SUBJECT");
    })();
    expect(err.code).toBe("INCOMPLETE_SUBJECT");

    // The next accepted HRIS event for that employee supplies the facts.
    expect((await deliver(legacy)).statusCode).toBe(202);
    expect(policySubjectFromEmployee((await employeeRow(legacy.employeeId))!).department).toBe(
      "ENGINEERING",
    );
  });

  it("is protected by database constraints against partial or invalid facts", async () => {
    const event = offerSignedEvent();
    await deliver(event);
    const where = sql`hris_employee_id = ${event.employeeId}`;
    await expect(
      handle.db.execute(sql`UPDATE employees SET employment_type = NULL WHERE ${where}`),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`UPDATE employees SET department_code = 'LEGAL' WHERE ${where}`),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`UPDATE employees SET role_family_code = 'sre' WHERE ${where}`),
    ).rejects.toThrow();
  });
});
