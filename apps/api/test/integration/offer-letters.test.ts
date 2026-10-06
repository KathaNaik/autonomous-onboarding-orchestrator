import { randomUUID } from "node:crypto";
import { createOfferLetterAgent } from "@aoo/agents";
import { createScriptedModelProvider, syntheticOfferLetter } from "@aoo/agents/testing";
import { createDatabase, type DatabaseHandle } from "@aoo/db";
import { createHrisIntakeService, createOfferLetterService } from "@aoo/orchestrator";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "hr.alice" };
let app: FastifyInstance;
let handle: DatabaseHandle;
const proposal = {
  isOfferLetter: true,
  firstName: "Ada",
  lastName: "Example",
  workEmail: "ada.example@example.com",
  jobTitle: "Backend Software Engineer",
  department: "Engineering",
  managerName: "Sam Lead",
  startDate: null,
  jobSummary: null,
  warnings: ["AMBIGUOUS_START_DATE"],
};
const pdf = Buffer.from(
  syntheticOfferLetter({
    candidate: "Ada Example",
    title: "Backend Software Engineer",
    department: "Engineering",
  }),
);

const provider = createScriptedModelProvider([{ output: proposal }]);
beforeAll(async () => {
  handle = createDatabase(inject("databaseUrl"));
  app = await buildApp(
    testConfig({
      DATABASE_URL: inject("databaseUrl"),
      ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN,
      OFFER_LETTER_INTAKE_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-not-used-because-the-agent-is-scripted",
    } as never),
    {
      offerLetters: createOfferLetterService(handle.db, {
        agent: createOfferLetterAgent({
          provider,
          maxAttempts: 1,
        }),
        intake: createHrisIntakeService(handle.db),
      }),
    },
  );
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const counts = async () =>
  (
    await handle.db.execute<Record<string, number>>(sql`
      SELECT (SELECT count(*)::int FROM offer_letter_extractions) AS extractions,
             (SELECT count(*)::int FROM employees) AS employees,
             (SELECT count(*)::int FROM hris_event_receipts) AS receipts,
             (SELECT count(*)::int FROM onboarding_workflows) AS workflows,
             (SELECT count(*)::int FROM outbox_events) AS outbox`)
  ).rows[0]!;
const upload = (
  body: Buffer | string,
  headers: Record<string, string> = auth,
  type = "application/pdf",
) =>
  app.inject({
    method: "POST",
    url: "/admin/offer-letters",
    headers: { ...headers, "content-type": type },
    payload: body,
  });
const confirmed = {
  firstName: "Ada",
  lastName: "Example",
  email: `ada.${randomUUID().slice(0, 6)}@example.com`,
  role: "Backend Software Engineer",
  department: "Engineering",
  managerId: "Sam Lead",
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
  offerSignedAndCleared: true,
};

describe("(M11) offer-letter intake API", () => {
  it("upload → proposal → read back → start → workflow; a resubmit is a 200 duplicate", async () => {
    const res = await upload(pdf);
    expect(res.statusCode).toBe(201);
    const view = res.json();
    expect(view).toMatchObject({
      status: "EXTRACTED",
      uploadedBy: "hr.alice",
      proposal: { firstName: "Ada" },
    });
    const read = await app.inject({
      method: "GET",
      url: `/admin/offer-letters/${view.extractionId}`,
      headers: auth,
    });
    expect(read.json()).toEqual(view);
    const start = (body: unknown) =>
      app.inject({
        method: "POST",
        url: `/admin/offer-letters/${view.extractionId}/start`,
        headers: { ...auth, "content-type": "application/json" },
        payload: body as object,
      });
    const first = await start(confirmed);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ workflowCreated: true, duplicate: false });
    const again = await start(confirmed);
    expect([again.statusCode, again.json().workflowId]).toEqual([200, first.json().workflowId]);
    const conflict = await start({ ...confirmed, role: "Changed" });
    expect([conflict.statusCode, conflict.json().error]).toEqual([409, "ALREADY_SUBMITTED"]);
    const after = await app.inject({
      method: "GET",
      url: `/admin/offer-letters/${view.extractionId}`,
      headers: auth,
    });
    expect(after.json()).toMatchObject({
      status: "SUBMITTED",
      workflowId: first.json().workflowId,
    });
  });

  it("refuses unauthenticated, revoked-session, wrong-type, oversized and anonymous uploads with no writes", async () => {
    const before = await counts();
    const callsBefore = provider.calls.length;
    expect((await upload(pdf, { "x-operator-id": "hr.alice" })).statusCode).toBe(401);
    expect(
      (await upload(pdf, { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" }))
        .statusCode,
    ).toBe(401);
    const revoked = randomUUID();
    await app.inject({
      method: "POST",
      url: "/admin/operator-sessions/revoke",
      headers: { ...auth, "content-type": "application/json" },
      payload: { sessionNonce: revoked, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    expect((await upload(pdf, { ...auth, "x-operator-session": revoked })).statusCode).toBe(401);
    const wrongType = await upload("hello", auth, "text/plain");
    expect([wrongType.statusCode, wrongType.json().error]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);
    const big = await upload(Buffer.alloc(4 * 1024 * 1024 + 10, 0x25));
    expect([big.statusCode, big.json().error]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
    const notPdf = await upload(Buffer.from("not a pdf at all"));
    expect([notPdf.statusCode, notPdf.json().error]).toEqual([422, "INVALID_DOCUMENT"]);
    const malformed = await upload(Buffer.from("%PDF-1.7\n1 0 obj << /Broken"));
    expect([malformed.statusCode, malformed.json().error]).toEqual([422, "INVALID_DOCUMENT"]);
    const truncated = await upload(pdf.subarray(0, pdf.byteLength - 40));
    expect([truncated.statusCode, truncated.json().error]).toEqual([422, "INVALID_DOCUMENT"]);
    const anonymous = await upload(pdf, { authorization: auth.authorization });
    expect([anonymous.statusCode, anonymous.json().error]).toEqual([400, "OPERATOR_ID_REQUIRED"]);
    // Nothing reached the model; no extraction, employee, receipt, workflow or outbox row.
    expect(provider.calls.length).toBe(callsBefore);
    expect(await counts()).toEqual(before);
  });

  it("unknown or malformed extraction ids are 404; bad start bodies are 400 without writes", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/admin/offer-letters/${randomUUID()}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/admin/offer-letters/..%2Fx", headers: auth }))
        .statusCode,
    ).toBe(404);
    const { extractionId } = (await upload(pdf)).json();
    const before = await counts();
    const bad = await app.inject({
      method: "POST",
      url: `/admin/offer-letters/${extractionId}/start`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { ...confirmed, offerSignedAndCleared: false },
    });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    expect(bad.json().message).not.toContain("Ada");
    // Lookup and submit without operator credentials: 401 before any read or write.
    for (const headers of [{}, { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" }]) {
      const read = await app.inject({
        method: "GET",
        url: `/admin/offer-letters/${extractionId}`,
        headers: { ...headers, "x-operator-id": "hr.alice" },
      });
      const start = await app.inject({
        method: "POST",
        url: `/admin/offer-letters/${extractionId}/start`,
        headers: { ...headers, "x-operator-id": "hr.alice", "content-type": "application/json" },
        payload: confirmed,
      });
      expect([read.statusCode, start.statusCode]).toEqual([401, 401]);
    }
    expect(await counts()).toEqual(before);
  });
});

describe("(M11) disabled by default", () => {
  it("routes are not registered unless OFFER_LETTER_INTAKE_ENABLED=true", async () => {
    const off = await buildApp(
      testConfig({ DATABASE_URL: inject("databaseUrl"), ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }),
    );
    const res = await off.inject({
      method: "POST",
      url: "/admin/offer-letters",
      headers: { ...auth, "content-type": "application/pdf" },
      payload: pdf,
    });
    expect(res.statusCode).toBe(404);
    await off.close();
  });
});
