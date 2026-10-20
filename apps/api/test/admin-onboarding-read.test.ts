import { ReadModelError, type WorkflowReadService } from "@aoo/orchestrator";
import type { WorkflowObservabilityView, WorkflowSummary } from "@aoo/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { normalizeRequestId } from "../src/observability.js";
import { TEST_SECRET, testConfig } from "./helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const WF = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
const listWorkflows = vi.fn<WorkflowReadService["listWorkflows"]>();
const getWorkflowObservabilityView = vi.fn<WorkflowReadService["getWorkflowObservabilityView"]>();
let app: FastifyInstance;
const lines: string[] = [];

const summary: WorkflowSummary = {
  workflowId: WF,
  state: "COMPLETED",
  employee: {
    hrisEmployeeId: "E-1",
    displayName: "Grace Hopper",
    jobTitle: null,
    startDate: null,
    facts: null,
  },
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:01.000Z",
  completedAt: "2026-09-30T00:00:01.000Z",
  failureReason: null,
  provisioningPlanStatus: "COMPLETE",
  onboardingPlanStatus: "ACCEPTED",
  resourceProgress: {
    total: 0,
    settled: 0,
    provisioned: 0,
    denied: 0,
    rejected: 0,
    inProgress: 0,
    failed: 0,
  },
  blockers: [],
};
const view = (): WorkflowObservabilityView => ({
  generatedAt: "2026-09-30T00:00:02.000Z",
  workflow: {
    workflowId: WF,
    state: "COMPLETED",
    version: 7,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    completedAt: summary.completedAt,
    failureReason: null,
  },
  employee: {
    hrisEmployeeId: "E-1",
    displayName: "Grace Hopper",
    workEmail: "grace@example.com",
    facts: null,
    factsSourceEventId: null,
    jobTitle: null,
    departmentDisplay: null,
    startDate: null,
  },
  hrisEvents: [],
  roleAccessRun: null,
  policyDecisions: [],
  provisioningPlan: null,
  resources: [],
  approvals: [],
  fulfillments: [],
  identities: [],
  githubClaim: null,
  externalOperations: [],
  onboardingPlanRun: null,
  onboardingPlan: null,
  timeline: [],
  correlation: { correlationIds: [], traceIds: [], outboxEvents: [], providerCorrelationKeys: [] },
  notes: [],
});

beforeAll(async () => {
  app = await buildApp(
    testConfig({ ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN, LOG_LEVEL: "info" }),
    { workflowReads: { listWorkflows, getWorkflowObservabilityView } },
    { logStream: { write: (line) => void lines.push(line) } },
  );
});
afterAll(() => app.close());
beforeEach(() => {
  listWorkflows.mockReset().mockResolvedValue({
    items: [summary],
    summary: { total: 1, inProgress: 0, needsAttention: 0, completed: 1, failed: 0 },
    nextCursor: null,
  });
  getWorkflowObservabilityView.mockReset().mockResolvedValue(view());
  lines.length = 0;
});

const get = (url: string, headers: Record<string, string> = auth) =>
  app.inject({ method: "GET", url, headers });

describe("operator read API: authorization", () => {
  it.each([
    ["no token", {}],
    ["wrong token", { authorization: "Bearer wrong-token-0123456789abcdef0123456789" }],
    ["non-Bearer", { authorization: `Basic ${ADMIN_TOKEN}` }],
    ["the HRIS secret", { authorization: `Bearer ${TEST_SECRET}` }],
  ])("%s → 401 before any read (existence never revealed)", async (_, headers) => {
    for (const url of ["/admin/onboarding", `/admin/onboarding/${WF}`]) {
      const res = await get(url, headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: "OPERATOR_UNAUTHORIZED",
        message: "operator authorization required",
      });
    }
    expect(listWorkflows).not.toHaveBeenCalled();
    expect(getWorkflowObservabilityView).not.toHaveBeenCalled();
  });

  it("the correct token is allowed; X-Operator-Id is optional but validated when present", async () => {
    expect((await get("/admin/onboarding")).statusCode).toBe(200);
    expect(
      (await get(`/admin/onboarding/${WF}`, { ...auth, "x-operator-id": "hr.alice" })).statusCode,
    ).toBe(200);
    const bad = await get(`/admin/onboarding/${WF}`, { ...auth, "x-operator-id": "not valid!" });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "OPERATOR_ID_INVALID"]);
  });

  it("is not registered without ONBOARDING_ADMIN_TOKEN (no anonymous access)", async () => {
    const bare = await buildApp(testConfig(), {
      workflowReads: { listWorkflows, getWorkflowObservabilityView },
    });
    expect((await bare.inject({ method: "GET", url: "/admin/onboarding" })).statusCode).toBe(404);
    await bare.close();
  });
});

describe("operator read API: contracts", () => {
  it("returns only DTO fields (unlisted properties are stripped)", async () => {
    getWorkflowObservabilityView.mockResolvedValue({
      ...view(),
      rawRow: { password: "hunter2" },
      employee: { ...view().employee, ssn: "123-45-6789" },
    } as never);
    const body = (await get(`/admin/onboarding/${WF}`)).json();
    expect(body).not.toHaveProperty("rawRow");
    expect(body.employee).not.toHaveProperty("ssn");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("maps not-found, invalid queries and failures safely (no stack traces)", async () => {
    getWorkflowObservabilityView.mockRejectedValueOnce(
      new ReadModelError("WORKFLOW_NOT_FOUND", "x"),
    );
    const nf = await get(`/admin/onboarding/${WF}`);
    expect([nf.statusCode, nf.json().error]).toEqual([404, "WORKFLOW_NOT_FOUND"]);
    listWorkflows.mockRejectedValueOnce(new ReadModelError("INVALID_QUERY", "invalid cursor"));
    expect((await get("/admin/onboarding?cursor=bad")).statusCode).toBe(400);
    getWorkflowObservabilityView.mockRejectedValueOnce(
      Object.assign(new Error("db failed at /secret/path password=hunter2"), {
        stack: "at secret.ts:1",
      }),
    );
    const err = await get(`/admin/onboarding/${WF}`);
    expect(err.statusCode).toBe(500);
    expect(err.json()).toEqual({ error: "INTERNAL_ERROR", message: "request failed; try again" });
    expect(err.body).not.toContain("hunter2");
    expect(err.body).not.toContain("secret.ts");
  });

  it("passes the query to the read model (it validates limit/cursor/state)", async () => {
    await get("/admin/onboarding?limit=10&state=COMPLETED");
    expect(listWorkflows).toHaveBeenCalledWith({ limit: "10", state: "COMPLETED" });
  });
});

describe("request ids and logs", () => {
  it("reuses a safe X-Request-Id, replaces unsafe ones, and returns it", async () => {
    const reused = await get("/health", { "x-request-id": "req-abc-12345" });
    expect(reused.headers["x-request-id"]).toBe("req-abc-12345");
    for (const bad of ["short", "x".repeat(200), "has space inside", "<script>alert(1)</script>"]) {
      const res = await get("/health", { "x-request-id": bad });
      expect(res.headers["x-request-id"]).not.toBe(bad);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(normalizeRequestId(["req-abc-12345", "x"])).toBe("req-abc-12345");
  });

  it("logs the request id and operator, never the Authorization header or token", async () => {
    await get(`/admin/onboarding/${WF}`, {
      ...auth,
      "x-operator-id": "hr.alice",
      "x-request-id": "req-log-000001",
    });
    const joined = lines.join("\n");
    expect(joined).toContain('"requestId":"req-log-000001"');
    expect(joined).toContain('"operatorId":"hr.alice"');
    expect(joined).not.toContain(ADMIN_TOKEN);
    expect(joined).not.toMatch(/"authorization"/i);
  });
});
