import {
  auditEvents,
  createDatabase,
  externalIdentityClaims,
  hrisEventReceipts,
  type DatabaseHandle,
} from "@aoo/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { offerSignedEvent, signedRequest, testConfig } from "../helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
let app: FastifyInstance;
let handle: DatabaseHandle;

beforeAll(async () => {
  app = await buildApp(
    testConfig({ DATABASE_URL: inject("databaseUrl"), ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }),
  );
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

async function hire(extra: Record<string, unknown> = {}) {
  const req = signedRequest(offerSignedEvent(extra));
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/hris",
    payload: req.body,
    headers: req.headers,
  });
  expect(res.statusCode).toBe(202);
  return res.json().workflowId as string;
}

const record = (workflowId: string, githubLogin: unknown, token = ADMIN_TOKEN) =>
  app.inject({
    method: "POST",
    url: `/admin/onboarding/${workflowId}/github-identity`,
    headers: { authorization: `Bearer ${token}`, "x-operator-id": "hr.alice" },
    payload: { githubLogin },
  });

const claimsFor = (workflowId: string) =>
  handle.db
    .select()
    .from(externalIdentityClaims)
    .where(eq(externalIdentityClaims.workflowId, workflowId));

describe("HR-recorded GitHub identity through the API (real PostgreSQL)", () => {
  it("HRIS carries no GitHub login: a githubLogin field is stripped and creates no claim", async () => {
    const workflowId = await hire({ githubLogin: "from-hris" });
    const [receipt] = await handle.db
      .select()
      .from(hrisEventReceipts)
      .where(eq(hrisEventReceipts.workflowId, workflowId));
    expect(receipt!.payload).not.toHaveProperty("githubLogin");
    expect(await claimsFor(workflowId)).toHaveLength(0);
  });

  it("records, corrects and deduplicates HR's claim, with the operator in the audit trail", async () => {
    const workflowId = await hire();
    const first = await record(workflowId, "typo-user");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      changed: true,
      employee: { workEmail: expect.stringContaining("@example.com") },
      identity: { state: "SUBMITTED", claimedLogin: "typo-user", resolvedLogin: null },
    });
    expect((await record(workflowId, "real-user")).json().changed).toBe(true);
    expect((await record(workflowId, "real-user")).json().changed).toBe(false);
    expect(await claimsFor(workflowId)).toMatchObject([
      { claimedLogin: "real-user", source: "HR_INPUT", recordedBy: "hr.alice" },
    ]);
    const audits = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.actor, "hr:hr.alice")));
    expect(audits.map((a) => a.eventType).sort()).toEqual([
      "github.identity_claim_changed",
      "github.identity_claim_recorded",
    ]);
    const bad = await record(workflowId, "bad_user!");
    expect([bad.statusCode, bad.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
  });

  it("without the operator token nothing changes", async () => {
    const workflowId = await hire();
    await record(workflowId, "right-user");
    const res = await record(
      workflowId,
      "attacker-user",
      "wrong-token-0123456789abcdef-0123456789",
    );
    expect([res.statusCode, res.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
    expect(await claimsFor(workflowId)).toMatchObject([{ claimedLogin: "right-user" }]);
    const unknown = await record("00000000-0000-4000-8000-000000000000", "someone");
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, "WORKFLOW_NOT_FOUND"]);
  });
});
