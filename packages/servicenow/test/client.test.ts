import { describe, expect, it } from "vitest";
import { createServiceNowClient } from "../src/client.js";
import {
  ServiceNowAuthError,
  ServiceNowPermissionError,
  ServiceNowRequestError,
  ServiceNowResponseError,
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

const client = (f: ReturnType<typeof fakeFetch>, extra = {}) =>
  createServiceNowClient(config, { fetch: f.fetch, ...noSleep, ...extra });

describe("successful authenticated reads", () => {
  it("verifyConnectivity reads one row of the configured table with basic auth", async () => {
    const f = fakeFetch(json({ result: [{ sys_id: SYS_ID }] }));
    const result = await client(f).verifyConnectivity();

    expect(result).toMatchObject({
      instanceUrl: config.instanceUrl,
      table: config.accessRequestTable,
      username: "aoo.integration",
      sampleCount: 1,
    });
    const { url, init } = f.calls[0]!;
    expect(url.pathname).toBe(`/api/now/table/${config.accessRequestTable}`);
    expect(url.searchParams.get("sysparm_limit")).toBe("1");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`aoo.integration:${PASSWORD}`).toString("base64")}`,
    );
    expect(headers.Accept).toBe("application/json");
  });

  it("queryAccessRequests returns typed records and builds a safe encoded query", async () => {
    const f = fakeFetch(json({ result: [record(), record({ policy_decision: "" })] }));
    const rows = await client(f).queryAccessRequests({
      workflowId: "wf-1",
      employeeId: "HRIS-100",
      limit: 20,
    });

    expect(rows[0]).toEqual({
      sysId: SYS_ID,
      sysClassName: config.accessRequestTable,
      number: "OAR0001001",
      state: "1",
      shortDescription: "GitHub team membership",
      createdOn: "2026-09-23 10:00:00",
      updatedOn: "2026-09-23 10:00:00",
      employeeId: "HRIS-100",
      workflowId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      resourceId: "github:team:platform",
      requestedEntitlement: "member",
      agentReason: "Role requires platform repo access",
      policyDecision: "requires_approval",
      approvalState: "pending",
      correlationKey: "wf-7c9e6679:github:team:platform",
    });
    expect(rows[1]?.policyDecision).toBeNull();

    const params = f.calls[0]!.url.searchParams;
    expect(params.get("sysparm_query")).toBe(
      "employee_id=HRIS-100^workflow_id=wf-1^ORDERBYDESCsys_created_on",
    );
    expect(params.get("sysparm_limit")).toBe("20");
    expect(params.get("sysparm_offset")).toBe("0");
    expect(params.get("sysparm_display_value")).toBe("false");
    expect(params.get("sysparm_exclude_reference_link")).toBe("true");
    expect(params.get("sysparm_fields")?.split(",")).toContain("correlation_key");
  });

  it("getAccessRequest reads by sys_id and returns null for 404", async () => {
    const f = fakeFetch(
      json({ result: record() }),
      json({ error: { message: "No Record found" } }, 404),
    );
    const c = client(f);
    expect((await c.getAccessRequest(SYS_ID))?.number).toBe("OAR0001001");
    expect(f.calls[0]!.url.pathname).toBe(`/api/now/table/${config.accessRequestTable}/${SYS_ID}`);
    expect(await c.getAccessRequest("f".repeat(32))).toBeNull();
  });

  it("describes the table from sys_db_object and sys_dictionary", async () => {
    const f = fakeFetch(
      json({
        result: [
          {
            name: config.accessRequestTable,
            label: "Onboarding Access Request",
            "super_class.name": "task",
            "sys_scope.scope": "x_1234567_autonomo",
          },
        ],
      }),
      json({
        result: [
          {
            element: "correlation_key",
            internal_type: "string",
            max_length: "255",
            mandatory: "true",
            unique: "true",
            default_value: "",
          },
        ],
      }),
      json({
        result: [
          { element: "policy_decision", value: "pending", label: "Pending", inactive: "false" },
          { element: "policy_decision", value: "allow", label: "Allow", inactive: "false" },
          { element: "policy_decision", value: "retired", label: "Retired", inactive: "true" },
        ],
      }),
    );
    const d = await client(f).describeAccessRequestTable();
    expect(d).toMatchObject({ superClass: "task", scope: "x_1234567_autonomo" });
    expect(d.columns).toEqual([
      {
        name: "correlation_key",
        internalType: "string",
        maxLength: 255,
        mandatory: true,
        unique: true,
        defaultValue: "",
      },
    ]);
    expect(d.choices).toEqual({ policy_decision: ["pending", "allow"] });
    expect(f.calls[2]!.url.pathname).toBe("/api/now/table/sys_choice");
    expect(f.calls[2]!.url.searchParams.get("sysparm_query")).toBe(
      `name=${config.accessRequestTable}^ORDERBYsequence`,
    );
    expect(f.calls[1]!.url.searchParams.get("sysparm_query")).toBe(
      `name=${config.accessRequestTable}^elementISNOTEMPTY`,
    );
  });
});

describe("invalid credentials and permissions", () => {
  it("maps 401 to ServiceNowAuthError without retrying", async () => {
    const f = fakeFetch(json({ error: { message: "User Not Authenticated" } }, 401));
    const err = await client(f)
      .verifyConnectivity()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceNowAuthError);
    expect(err).toMatchObject({ code: "AUTHENTICATION_FAILED", status: 401, retryable: false });
    expect(f.calls).toHaveLength(1);
  });

  it("maps 403 to ServiceNowPermissionError without retrying", async () => {
    const f = fakeFetch(json({ error: { message: "Insufficient rights" } }, 403));
    await expect(client(f).queryAccessRequests()).rejects.toBeInstanceOf(ServiceNowPermissionError);
    expect(f.calls).toHaveLength(1);
  });

  it("maps 400 (e.g. unknown table) to BAD_REQUEST", async () => {
    const f = fakeFetch(json({ error: { message: "Invalid table x_bad" } }, 400));
    await expect(client(f).verifyConnectivity()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });
});

describe("timeouts and unavailable instances", () => {
  it("times out each attempt and gives up after maxRetries + 1 attempts", async () => {
    const f = fakeFetch("hang", "hang", "hang");
    const err = await client(f)
      .verifyConnectivity()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceNowTimeoutError);
    expect(err).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(err.message).toContain("50ms");
    expect(f.calls).toHaveLength(3);
  });

  it("retries network failures, then raises UNAVAILABLE", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const f = fakeFetch(refused, refused, refused);
    await expect(client(f).verifyConnectivity()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    expect(f.calls).toHaveLength(3);
  });

  it("recovers when a transient 503 is followed by success", async () => {
    const f = fakeFetch(json({}, 503), json({ result: [] }));
    expect((await client(f).verifyConnectivity()).sampleCount).toBe(0);
    expect(f.calls).toHaveLength(2);
  });

  it("honors Retry-After on 429, capped", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch(json({}, 429, { "retry-after": "2" }), json({ result: [] }));
    await createServiceNowClient(config, {
      fetch: f.fetch,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).verifyConnectivity();
    expect(sleeps[0]).toBe(2000);
  });

  it("gives up on persistent 5xx after bounded retries", async () => {
    const f = fakeFetch(json({}, 502), json({}, 503), json({}, 504));
    await expect(client(f).verifyConnectivity()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 504,
    });
    expect(f.calls).toHaveLength(3);
  });

  it("reports a hibernating PDI (HTML page or redirect) as INSTANCE_UNAVAILABLE", async () => {
    const html = new Response("<html>Your instance is hibernating</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(client(fakeFetch(html)).verifyConnectivity()).rejects.toMatchObject({
      code: "INSTANCE_UNAVAILABLE",
    });
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://developer.servicenow.com" },
    });
    await expect(client(fakeFetch(redirect)).verifyConnectivity()).rejects.toBeInstanceOf(
      ServiceNowUnavailableError,
    );
  });
});

describe("malformed responses", () => {
  it("rejects invalid JSON", async () => {
    const bad = new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(client(fakeFetch(bad)).verifyConnectivity()).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects a response without the result envelope", async () => {
    await expect(
      client(fakeFetch(json({ records: [] }))).verifyConnectivity(),
    ).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
    });
  });

  it("names missing columns when the table does not match the expected schema", async () => {
    const { workflow_id: _, ...withoutWorkflow } = record();
    const err = await client(fakeFetch(json({ result: [withoutWorkflow] })))
      .queryAccessRequests()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceNowResponseError);
    expect(err.code).toBe("SCHEMA_MISMATCH");
    expect(err.message).toContain("workflow_id");
  });

  it("rejects unknown policy decisions and invalid sys_ids from the server", async () => {
    await expect(
      client(
        fakeFetch(json({ result: [record({ policy_decision: "maybe" })] })),
      ).queryAccessRequests(),
    ).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
    await expect(
      client(fakeFetch(json({ result: [record({ sys_id: "nope" })] }))).queryAccessRequests(),
    ).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  });
});

describe("input validation (no request sent)", () => {
  it("rejects malformed sys_ids", async () => {
    const f = fakeFetch();
    await expect(client(f).getAccessRequest("../../sys_user")).rejects.toBeInstanceOf(
      ServiceNowRequestError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("rejects query values that could inject encoded-query operators", async () => {
    const f = fakeFetch();
    await expect(
      client(f).queryAccessRequests({ workflowId: "x^ORsys_id!=0" }),
    ).rejects.toBeInstanceOf(ServiceNowRequestError);
    await expect(client(f).queryAccessRequests({ limit: 5000 })).rejects.toBeInstanceOf(
      ServiceNowRequestError,
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe("no credentials in logs or errors", () => {
  it("logs method, path, status and timing only", async () => {
    const { lines, logger } = captureLogger();
    const f = fakeFetch(json({}, 503), json({ result: [record()] }));
    await client(f, { logger }).queryAccessRequests({ employeeId: "HRIS-SENSITIVE-100" });

    const text = JSON.stringify(lines);
    expect(lines.some((l) => l.msg === "servicenow request")).toBe(true);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(Buffer.from(`aoo.integration:${PASSWORD}`).toString("base64"));
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toContain("HRIS-SENSITIVE-100"); // query values are not logged
    expect(text).not.toContain("Role requires platform"); // response bodies are not logged
  });

  it("errors carry no credentials, headers or response bodies", async () => {
    const body = { error: { message: `bad login for ${PASSWORD}` }, secret: "x" };
    for (const status of [401, 403, 400, 418]) {
      const err = await client(fakeFetch(json(body, status)))
        .verifyConnectivity()
        .catch((e) => e);
      const text = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("bad login");
    }
  });

  it("redacts credentials embedded in network error causes", async () => {
    const leaky = new TypeError(
      `fetch failed for https://aoo.integration:${PASSWORD}@dev00000.service-now.com`,
    );
    const { lines, logger } = captureLogger();
    const err = await client(fakeFetch(leaky, leaky, leaky), { logger })
      .verifyConnectivity()
      .catch((e) => e);
    expect(JSON.stringify(err.cause)).not.toContain(PASSWORD);
    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
  });
});
