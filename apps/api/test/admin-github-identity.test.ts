import { createHmac } from "node:crypto";
import { GitHubIdentityError, type GitHubIdentityService } from "@aoo/orchestrator";
import type { GitHubIdentityStatus } from "@aoo/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_SECRET, testConfig } from "./helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const WF = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const url = `/admin/onboarding/${WF}/github-identity`;
const operator = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "hr.alice" };

const status: GitHubIdentityStatus = {
  workflowId: WF,
  employee: { firstName: "Grace", lastName: "Hopper", workEmail: "grace@example.com" },
  identityRequired: true,
  identity: { state: "SUBMITTED", claimedLogin: "octocat", resolvedLogin: null },
  resources: [
    {
      resourceId: "github-org-membership",
      displayName: "GitHub org",
      progress: "WAITING_TO_START",
    },
  ],
};
const getStatus = vi.fn<GitHubIdentityService["getStatus"]>();
const submitClaim = vi.fn<GitHubIdentityService["submitClaim"]>();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig({ ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }), {
    githubIdentities: { getStatus, submitClaim },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  getStatus.mockReset().mockResolvedValue(status);
  submitClaim.mockReset().mockResolvedValue({ ...status, changed: true });
});

const post = (payload: unknown, headers: Record<string, string> = operator) =>
  app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

describe("GET/POST /admin/onboarding/:workflowId/github-identity (HR/operator)", () => {
  it("records the username for an authorized operator, with the operator id for audit", async () => {
    const res = await post({ githubLogin: "octocat" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...status, changed: true });
    expect(submitClaim).toHaveBeenCalledWith({
      workflowId: WF,
      githubLogin: "octocat",
      operatorId: "hr.alice",
    });
    const get = await app.inject({ method: "GET", url, headers: operator });
    expect([get.statusCode, get.json()]).toEqual([200, status]);
  });

  it("rejects employee onboarding tokens, missing and wrong operator tokens before any service call", async () => {
    // An employee-style per-workflow onboarding link token (the removed v1 scheme) is not operator auth.
    const employeeToken =
      "v1." +
      createHmac("sha256", ADMIN_TOKEN).update(`aoo-onboarding:v1:${WF}`).digest("base64url");
    const attempts = [
      { "x-onboarding-token": employeeToken, "x-operator-id": "hr.alice" },
      { authorization: `Bearer ${employeeToken}`, "x-operator-id": "hr.alice" },
      { "x-operator-id": "hr.alice" },
      { authorization: `Bearer ${ADMIN_TOKEN}x`, "x-operator-id": "hr.alice" },
      { authorization: ADMIN_TOKEN, "x-operator-id": "hr.alice" },
      { authorization: `Bearer ${TEST_SECRET}`, "x-operator-id": "hr.alice" },
    ];
    for (const headers of attempts) {
      const res = await post({ githubLogin: "attacker" }, headers);
      expect([res.statusCode, res.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
      const get = await app.inject({ method: "GET", url, headers });
      expect(get.statusCode).toBe(401);
    }
    // Unauthenticated garbage bodies are refused as unauthorized, not parsed.
    const garbage = await post("not json", {});
    expect(garbage.statusCode).toBe(401);
    expect(submitClaim).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("requires an operator id and a well-formed body", async () => {
    const noOperator = await post(
      { githubLogin: "octocat" },
      { authorization: operator.authorization },
    );
    expect([noOperator.statusCode, noOperator.json().error]).toEqual([400, "OPERATOR_ID_REQUIRED"]);
    for (const payload of ["not json", [], { githubLogin: "octocat", role: "admin" }, "null"]) {
      const res = await post(payload);
      expect([res.statusCode, res.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    }
    const html = await app.inject({
      method: "POST",
      url,
      headers: { ...operator, "content-type": "text/html" },
      payload: "<b>octocat</b>",
    });
    expect([html.statusCode, html.json().error]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);
    expect((await post({ githubLogin: "a".repeat(2000) })).statusCode).toBe(400);
    expect(submitClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_GITHUB_LOGIN", 400, "INVALID_PAYLOAD"],
    ["WORKFLOW_NOT_FOUND", 404, "WORKFLOW_NOT_FOUND"],
    ["WORKFLOW_NOT_ACTIVE", 409, "WORKFLOW_NOT_ACTIVE"],
    ["GITHUB_IDENTITY_ALREADY_LINKED", 409, "GITHUB_IDENTITY_ALREADY_LINKED"],
  ] as const)("maps %s to %i", async (code, httpStatus, error) => {
    submitClaim.mockRejectedValueOnce(new GitHubIdentityError(code, "x"));
    const res = await post({ githubLogin: "octo_cat" });
    expect([res.statusCode, res.json().error]).toEqual([httpStatus, error]);
  });

  it("is not registered without ONBOARDING_ADMIN_TOKEN, and the old employee route is gone", async () => {
    const bare = await buildApp(testConfig(), { githubIdentities: { getStatus, submitClaim } });
    expect((await bare.inject({ method: "GET", url, headers: operator })).statusCode).toBe(404);
    await bare.close();
    const old = await app.inject({ method: "GET", url: `/onboarding/${WF}/github-identity` });
    expect(old.statusCode).toBe(404);
  });

  it("refuses to reuse the HRIS secret as the admin token", () => {
    expect(() => testConfig({ ONBOARDING_ADMIN_TOKEN: TEST_SECRET })).toThrow(/must differ/);
  });
});
