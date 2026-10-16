import { OperatorActionError, type OperatorActionService } from "@aoo/orchestrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const ID = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const WF = "7f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c";
const APPROVAL = "1a1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c";
const operator = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "hr.alice" };
const retryFailedResource = vi.fn<OperatorActionService["retryFailedResource"]>();
const requestApprovalAgain = vi.fn<OperatorActionService["requestApprovalAgain"]>();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig({ ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }), {
    operatorActions: { retryFailedResource, requestApprovalAgain },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  retryFailedResource.mockReset().mockResolvedValue({
    accessRequestId: ID,
    workflowId: WF,
    resourceId: "slack-engineering",
    status: "READY_FOR_PROVISIONING",
    retryGeneration: 1,
  });
  requestApprovalAgain.mockReset().mockResolvedValue({
    accessRequestId: ID,
    approvalId: APPROVAL,
    status: "REQUESTED",
    changed: true,
  });
});

const post = (action: string, headers: Record<string, string> = operator, id = ID) =>
  app.inject({ method: "POST", url: `/admin/access-requests/${id}/${action}`, headers });

describe("M13 operator actions", () => {
  it("retry: 200 with the operator id from the header", async () => {
    const res = await post("retry");
    expect([res.statusCode, res.json().retryGeneration]).toEqual([200, 1]);
    expect(retryFailedResource).toHaveBeenCalledWith({
      accessRequestId: ID,
      operatorId: "hr.alice",
    });
  });

  it("request approval again: 202 (recorded; the worker checks ServiceNow)", async () => {
    const res = await post("request-approval");
    expect([res.statusCode, res.json().status]).toEqual([202, "REQUESTED"]);
    expect(requestApprovalAgain).toHaveBeenCalledWith({
      accessRequestId: ID,
      operatorId: "hr.alice",
    });
  });

  it("refuses missing or wrong credentials before any service call", async () => {
    for (const action of ["retry", "request-approval"]) {
      for (const headers of [
        { "x-operator-id": "hr.alice" },
        { authorization: "Bearer not-the-admin-token-0123456789abcdef", "x-operator-id": "x" },
      ]) {
        const res = await post(action, headers);
        expect([res.statusCode, res.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
      }
    }
    expect(retryFailedResource).not.toHaveBeenCalled();
    expect(requestApprovalAgain).not.toHaveBeenCalled();
  });

  it("validates the operator id and the access request id", async () => {
    const noOperator = await post("retry", { authorization: operator.authorization });
    expect([noOperator.statusCode, noOperator.json().error]).toEqual([400, "OPERATOR_ID_REQUIRED"]);
    expect((await post("retry", operator, "not-a-uuid")).statusCode).toBe(404);
    expect(retryFailedResource).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FAILED", 409],
    ["NOT_AWAITING_APPROVAL", 409],
    ["NOT_IN_ACTIVE_PLAN", 409],
    ["WORKFLOW_NOT_ACTIVE", 409],
    ["ACCESS_REQUEST_NOT_FOUND", 404],
  ] as const)("maps %s to %i", async (code, status) => {
    retryFailedResource.mockRejectedValueOnce(new OperatorActionError(code, "nope"));
    const res = await post("retry");
    expect([res.statusCode, res.json().error]).toEqual([status, code]);
  });

  it("an unexpected error is a generic 500 without detail", async () => {
    requestApprovalAgain.mockRejectedValueOnce(new Error("db password=hunter2 exploded"));
    const res = await post("request-approval");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/hunter2|exploded/);
  });
});
