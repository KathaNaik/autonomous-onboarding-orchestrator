import { ManualCompletionError, type ManualProvisioningService } from "@aoo/orchestrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const ID = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const url = (id = ID) => `/admin/access-requests/${id}/manual-complete`;
const operator = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "hr.alice" };
const completeManualResource = vi.fn<ManualProvisioningService["completeManualResource"]>();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig({ ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }), {
    manualProvisioning: { completeManualResource },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  completeManualResource.mockReset().mockResolvedValue({
    accessRequestId: ID,
    workflowId: "7f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
    resourceId: "cursor-license",
    status: "PROVISIONED",
    changed: true,
    completedBy: "hr.alice",
    provisionedAt: new Date("2026-09-28T12:00:00Z"),
  });
});

const post = (payload: unknown, headers: Record<string, string> = operator, id = ID) =>
  app.inject({
    method: "POST",
    url: url(id),
    headers: { "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

describe("POST /admin/access-requests/:id/manual-complete", () => {
  it("completes for an authorized operator, passing the operator id and evidence", async () => {
    const res = await post({ evidence: "Seat assigned, ticket ABC-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "PROVISIONED",
      changed: true,
      provisionedAt: "2026-09-28T12:00:00.000Z",
    });
    expect(completeManualResource).toHaveBeenCalledWith({
      accessRequestId: ID,
      operatorId: "hr.alice",
      evidence: "Seat assigned, ticket ABC-123",
    });
  });

  it("refuses missing, wrong and employee-style credentials before parsing or any service call", async () => {
    for (const headers of [
      { "x-operator-id": "hr.alice" },
      { authorization: "Bearer not-the-admin-token-0123456789abcdef", "x-operator-id": "hr.alice" },
      { "x-onboarding-token": "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ]) {
      const res = await post({ evidence: "Seat assigned, ticket ABC-123" }, headers);
      expect([res.statusCode, res.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
    }
    expect((await post("not json", {})).statusCode).toBe(401);
    expect(completeManualResource).not.toHaveBeenCalled();
  });

  it("validates operator id, id and body shape", async () => {
    const noOperator = await post(
      { evidence: "Seat assigned" },
      { authorization: operator.authorization },
    );
    expect([noOperator.statusCode, noOperator.json().error]).toEqual([400, "OPERATOR_ID_REQUIRED"]);
    expect((await post({ evidence: "Seat assigned" }, operator, "not-a-uuid")).statusCode).toBe(
      404,
    );
    for (const payload of [{}, { evidence: 5 }, { evidence: "ok", extra: 1 }, "null", []]) {
      expect((await post(payload)).json().error).toBe("INVALID_PAYLOAD");
    }
    expect(completeManualResource).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_EVIDENCE", 400],
    ["ACCESS_REQUEST_NOT_FOUND", 404],
    ["PROVIDER_NOT_MANUAL", 409],
    ["NOT_IN_ACTIVE_PLAN", 409],
    ["NOT_AWAITING_MANUAL_ACTION", 409],
    ["MANUAL_ALREADY_COMPLETED", 409],
    ["AUTHORIZATION_CHAIN_INVALID", 409],
  ] as const)("maps %s to %i", async (code, status) => {
    completeManualResource.mockRejectedValueOnce(new ManualCompletionError(code, "x"));
    const res = await post({ evidence: "Seat assigned, ticket ABC-123" });
    expect([res.statusCode, res.json().error]).toEqual([status, code]);
  });

  it("is not registered without ONBOARDING_ADMIN_TOKEN", async () => {
    const bare = await buildApp(testConfig(), { manualProvisioning: { completeManualResource } });
    expect(
      (await bare.inject({ method: "POST", url: url(), headers: operator, payload: {} }))
        .statusCode,
    ).toBe(404);
    await bare.close();
  });
});
