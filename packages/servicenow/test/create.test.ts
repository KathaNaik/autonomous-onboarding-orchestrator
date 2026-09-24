import { describe, expect, it } from "vitest";
import { createServiceNowClient } from "../src/client.js";
import {
  ServiceNowAuthError,
  ServiceNowOutcomeUnknownError,
  ServiceNowPermissionError,
  ServiceNowRequestError,
  ServiceNowTimeoutError,
  ServiceNowUnavailableError,
} from "../src/errors.js";
import {
  PASSWORD,
  SYS_ID,
  captureLogger,
  config,
  fakeFetch,
  json,
  noSleep,
  record,
} from "./helpers.js";

const input = {
  shortDescription: "SYNTHETIC access request",
  employeeId: "HRIS-SECRET-EMP-42",
  workflowId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  resourceId: "github:team:platform",
  requestedEntitlement: "member",
  agentReason: "Confidential rationale about the employee",
  policyDecision: "pending" as const,
  correlationKey: "aoo-oar-0123456789abcdef",
};
const created = () =>
  json(
    {
      result: record({
        employee_id: input.employeeId,
        correlation_key: input.correlationKey,
        policy_decision: "pending",
      }),
    },
    201,
  );
const client = (f: ReturnType<typeof fakeFetch>, extra = {}) =>
  createServiceNowClient(config, { fetch: f.fetch, ...noSleep, ...extra });
const networkError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

describe("createAccessRequest", () => {
  it("POSTs the validated fields once and returns the validated created record", async () => {
    const f = fakeFetch(created());
    const rec = await client(f).createAccessRequest(input);

    expect(rec).toMatchObject({
      sysId: SYS_ID,
      correlationKey: input.correlationKey,
      policyDecision: "pending",
    });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe(`/api/now/table/${config.accessRequestTable}`);
    expect(url.searchParams.get("sysparm_input_display_value")).toBe("false");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      short_description: input.shortDescription,
      employee_id: input.employeeId,
      workflow_id: input.workflowId,
      resource_id: input.resourceId,
      requested_entitlement: input.requestedEntitlement,
      agent_reason: input.agentReason,
      policy_decision: "pending",
      approval_state: "not_required",
      correlation_key: input.correlationKey,
    });
  });

  it("rejects invalid input without sending anything", async () => {
    const f = fakeFetch();
    for (const bad of [
      { ...input, correlationKey: "bad^ORkey-123" },
      { ...input, employeeId: "x".repeat(101) },
      { ...input, policyDecision: "maybe" },
    ]) {
      await expect(client(f).createAccessRequest(bad as typeof input)).rejects.toBeInstanceOf(
        ServiceNowRequestError,
      );
    }
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["timeout", "hang" as const],
    ["connection reset", networkError("ECONNRESET")],
    ["socket closed", networkError("UND_ERR_SOCKET")],
  ])("%s after sending → OUTCOME_UNKNOWN, never retried", async (_, failure) => {
    const f = fakeFetch(failure, created());
    const err = await client(f)
      .createAccessRequest(input)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceNowOutcomeUnknownError);
    expect(err).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: true });
    expect(f.calls).toHaveLength(1);
  });

  it.each([500, 502, 503, 504])(
    "%i → OUTCOME_UNKNOWN (the server may have committed)",
    async (status) => {
      const f = fakeFetch(json({}, status), created());
      await expect(client(f).createAccessRequest(input)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        status,
      });
      expect(f.calls).toHaveLength(1);
    },
  );

  it("an unreadable 2xx body is OUTCOME_UNKNOWN, not success", async () => {
    const bad = new Response("{oops", {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    await expect(client(fakeFetch(bad)).createAccessRequest(input)).rejects.toBeInstanceOf(
      ServiceNowOutcomeUnknownError,
    );
    await expect(
      client(fakeFetch(json({ result: { sys_id: SYS_ID } }, 201))).createAccessRequest(input),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it.each([
    ["connection refused", networkError("ECONNREFUSED")],
    ["DNS failure", networkError("ENOTFOUND")],
  ])("%s → UNAVAILABLE with notSent=true", async (_, failure) => {
    const err = await client(fakeFetch(failure))
      .createAccessRequest(input)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceNowUnavailableError);
    expect(err.notSent).toBe(true);
  });

  it("429 and hibernation redirects are notSent", async () => {
    const e429 = await client(fakeFetch(json({}, 429)))
      .createAccessRequest(input)
      .catch((e) => e);
    expect(e429).toMatchObject({ code: "UNAVAILABLE", notSent: true });
    const e302 = await client(fakeFetch(new Response(null, { status: 302 })))
      .createAccessRequest(input)
      .catch((e) => e);
    expect(e302).toMatchObject({ code: "INSTANCE_UNAVAILABLE", notSent: true });
  });

  it("maps 401/403/400", async () => {
    await expect(
      client(fakeFetch(json({}, 401))).createAccessRequest(input),
    ).rejects.toBeInstanceOf(ServiceNowAuthError);
    await expect(
      client(fakeFetch(json({}, 403))).createAccessRequest(input),
    ).rejects.toBeInstanceOf(ServiceNowPermissionError);
    await expect(client(fakeFetch(json({}, 400))).createAccessRequest(input)).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
  });

  it("never logs the request body, employee data or credentials", async () => {
    const { lines, logger } = captureLogger();
    await client(fakeFetch(networkError("ECONNRESET")), { logger })
      .createAccessRequest(input)
      .catch(() => {});
    await client(fakeFetch(created()), { logger }).createAccessRequest(input);
    const text = JSON.stringify(lines);
    for (const secret of [PASSWORD, input.employeeId, input.agentReason, input.correlationKey]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("deadlines", () => {
  it("an already-expired deadline sends nothing (reads and writes)", async () => {
    const f = fakeFetch();
    const expired = AbortSignal.abort();
    await expect(client(f).queryAccessRequests({}, { signal: expired })).rejects.toBeInstanceOf(
      ServiceNowTimeoutError,
    );
    const err = await client(f)
      .createAccessRequest(input, { signal: expired })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "UNAVAILABLE", notSent: true });
    expect(f.calls).toHaveLength(0);
  });

  it("a deadline stops read retries even though retries remain", async () => {
    const controller = new AbortController();
    const f = fakeFetch(json({}, 503), json({}, 503), json({ result: [] }));
    const c = createServiceNowClient(
      { ...config, maxRetries: 5 },
      { fetch: f.fetch, random: () => 0, sleep: async () => controller.abort() },
    );
    await expect(c.queryAccessRequests({}, { signal: controller.signal })).rejects.toBeInstanceOf(
      ServiceNowTimeoutError,
    );
    expect(f.calls).toHaveLength(1);
  });

  it("a deadline aborts an in-flight POST as OUTCOME_UNKNOWN", async () => {
    const controller = new AbortController();
    const f = fakeFetch("hang");
    const pending = createServiceNowClient({ ...config, timeoutMs: 60_000 }, { fetch: f.fetch })
      .createAccessRequest(input, { signal: controller.signal })
      .catch((e) => e);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toBeInstanceOf(ServiceNowOutcomeUnknownError);
  });
});
