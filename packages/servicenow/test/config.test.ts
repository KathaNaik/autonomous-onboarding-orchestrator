import { describe, expect, it } from "vitest";
import { loadServiceNowConfig } from "../src/config.js";
import { ServiceNowConfigError } from "../src/errors.js";
import { checkAccessRequestTable, checkIntegrationAccess } from "../src/client.js";
import { ACCESS_REQUEST_TABLE_SPEC } from "../src/table-spec.js";
import { redact, redactText } from "../src/redact.js";

const env = {
  SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com",
  SERVICENOW_USERNAME: "aoo.integration",
  SERVICENOW_PASSWORD: "Very-Secret-Value-123",
  SERVICENOW_ACCESS_REQUEST_TABLE: "x_1234567_autonomo_onboarding_access_request",
};

describe("loadServiceNowConfig", () => {
  it("parses a valid environment with defaults", () => {
    expect(loadServiceNowConfig(env)).toEqual({
      instanceUrl: "https://dev12345.service-now.com",
      username: "aoo.integration",
      password: "Very-Secret-Value-123",
      accessRequestTable: "x_1234567_autonomo_onboarding_access_request",
      timeoutMs: 10_000,
      maxRetries: 2,
      retryBaseMs: 250,
    });
  });

  it("normalizes a trailing slash", () => {
    expect(
      loadServiceNowConfig({ ...env, SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com/" })
        .instanceUrl,
    ).toBe("https://dev12345.service-now.com");
  });

  it.each([
    ["missing everything", {}],
    ["http (not https)", { ...env, SERVICENOW_INSTANCE_URL: "http://dev12345.service-now.com" }],
    [
      "URL with a path",
      { ...env, SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com/api" },
    ],
    [
      "URL with embedded credentials",
      { ...env, SERVICENOW_INSTANCE_URL: "https://u:p@dev12345.service-now.com" },
    ],
    ["empty password", { ...env, SERVICENOW_PASSWORD: "" }],
    ["non-scoped table", { ...env, SERVICENOW_ACCESS_REQUEST_TABLE: "u_access_request" }],
    ["table with query characters", { ...env, SERVICENOW_ACCESS_REQUEST_TABLE: "x_a^ORb" }],
    ["timeout too small", { ...env, SERVICENOW_TIMEOUT_MS: "5" }],
    ["too many retries", { ...env, SERVICENOW_MAX_RETRIES: "50" }],
  ])("rejects %s", (_, input) => {
    expect(() => loadServiceNowConfig(input)).toThrow(ServiceNowConfigError);
  });

  it("names the invalid variables but never echoes their values", () => {
    const err = (() => {
      try {
        loadServiceNowConfig({
          ...env,
          SERVICENOW_INSTANCE_URL: "ftp://x",
          SERVICENOW_TIMEOUT_MS: "abc",
        });
      } catch (e) {
        return e as ServiceNowConfigError;
      }
    })()!;
    expect(err.message).toContain("SERVICENOW_INSTANCE_URL");
    expect(err.message).toContain("SERVICENOW_TIMEOUT_MS");
    expect(err.message).not.toContain("Very-Secret-Value-123");
    expect(JSON.stringify(err)).not.toContain("Very-Secret-Value-123");
  });
});

describe("redaction", () => {
  it("masks auth headers, URL credentials and secret-like key/value pairs", () => {
    const text = redactText(
      "Authorization: Basic YWRtaW46c2VjcmV0 then Bearer abc.def.ghi at https://admin:hunter2@x.service-now.com?password=hunter2&api_key=k",
    );
    expect(text).not.toMatch(/YWRtaW46c2VjcmV0|abc\.def\.ghi|hunter2|=k\b/);
    expect(text).toContain("[REDACTED]");
  });

  it("masks sensitive keys at any depth", () => {
    expect(
      redact({
        headers: { Authorization: "Basic x", accept: "json" },
        nested: [{ password: "p", ok: 1 }],
        clientSecret: "s",
      }),
    ).toEqual({
      headers: { Authorization: "[REDACTED]", accept: "json" },
      nested: [{ password: "[REDACTED]", ok: 1 }],
      clientSecret: "[REDACTED]",
    });
  });
});

describe("checkAccessRequestTable", () => {
  const good = {
    name: "x_1234567_autonomo_onboarding_access_request",
    label: "Onboarding Access Request",
    superClass: "task",
    scope: "x_1234567_autonomo",
    columns: ACCESS_REQUEST_TABLE_SPEC.columns.map((c) => ({
      name: c.name,
      internalType: c.type,
      maxLength: c.maxLength,
      mandatory: c.mandatory,
      unique: "unique" in c ? c.unique : false,
      defaultValue: "defaultValue" in c ? c.defaultValue : "",
    })),
    choices: {
      policy_decision: ["pending", "allow", "deny", "requires_approval"],
      approval_state: ["not_required", "pending", "approved", "rejected"],
    },
  };

  it("accepts a table that matches the spec", () => {
    expect(checkAccessRequestTable(good)).toEqual([]);
  });

  it("reports a wrong parent, missing columns, short fields and a non-unique correlation key", () => {
    const problems = checkAccessRequestTable({
      ...good,
      superClass: "",
      columns: good.columns
        .filter((c) => c.name !== "resource_id")
        .map((c) =>
          c.name === "correlation_key"
            ? { ...c, unique: false }
            : c.name === "employee_id"
              ? { ...c, maxLength: 10 }
              : c,
        ),
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('expected "task"'),
        "missing column resource_id",
        expect.stringContaining("employee_id max length 10"),
        "column correlation_key must be unique",
      ]),
    );
  });
});

describe("checkAccessRequestTable: choices and defaults", () => {
  const base = {
    name: "x_1234567_autonomo_onboarding_access_request",
    label: "Onboarding Access Request",
    superClass: "task",
    scope: "x_1234567_autonomo",
    columns: ACCESS_REQUEST_TABLE_SPEC.columns.map((c) => ({
      name: c.name,
      internalType: c.type,
      maxLength: c.maxLength,
      mandatory: c.mandatory,
      unique: "unique" in c ? c.unique : false,
      defaultValue: "defaultValue" in c ? c.defaultValue : "",
    })),
  };

  it("reports missing and unexpected policy_decision choices", () => {
    expect(
      checkAccessRequestTable({
        ...base,
        choices: {
          policy_decision: ["pending", "allow", "maybe"],
          approval_state: ["not_required", "pending", "approved", "rejected"],
        },
      }),
    ).toEqual([
      "column policy_decision is missing choices: deny, requires_approval",
      "column policy_decision has unexpected choices: maybe",
    ]);
    expect(
      checkAccessRequestTable({
        ...base,
        choices: { approval_state: ["not_required", "pending", "approved", "rejected"] },
      }),
    ).toEqual([
      "column policy_decision is missing choices: pending, allow, deny, requires_approval",
    ]);
  });

  it("reports a wrong default for policy_decision", () => {
    const columns = base.columns.map((c) =>
      c.name === "policy_decision" ? { ...c, defaultValue: "allow" } : c,
    );
    expect(
      checkAccessRequestTable({
        ...base,
        columns,
        choices: {
          policy_decision: ["pending", "allow", "deny", "requires_approval"],
          approval_state: ["not_required", "pending", "approved", "rejected"],
        },
      }),
    ).toEqual(['column policy_decision default is "allow", expected "pending"']);
  });
});

describe("checkIntegrationAccess", () => {
  const t = "x_1234567_autonomo_onboarding_access_request";
  const acl = (operation: string, name: string, roles: string[], active = true) => ({
    operation,
    name,
    roles,
    active,
  });
  const good = {
    acls: [
      acl("read", t, ["x.integration_reader"]),
      acl("read", `${t}.*`, ["x.integration_reader"]),
      acl("create", t, ["x.integration_writer"]),
      acl("create", `${t}.*`, ["x.integration_writer"]),
      acl("delete", t, ["x.admin"]),
      acl("write", t, ["x.user"]),
    ],
  };
  const roles = ["x.integration_reader", "x.integration_writer"];

  it("accepts read + create through held roles, with delete/write only for other roles", () => {
    expect(checkIntegrationAccess(t, good, roles)).toEqual([]);
  });

  it("flags missing create, a delete grant, a write grant, inactive ACLs and admin", () => {
    const problems = checkIntegrationAccess(
      t,
      {
        acls: [
          ...good.acls.filter((a) => a.operation !== "create"),
          acl("create", t, ["x.integration_writer"], false),
          acl("delete", t, ["x.integration_writer"]),
          acl("write", `${t}.*`, ["x.integration_reader"]),
        ],
      },
      [...roles, "admin"],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "integration user holds elevated role admin",
        `no active create ACL on ${t} for a role the integration user holds`,
        `no active create ACL on ${t}.* for a role the integration user holds`,
        `integration user is granted delete on ${t} via x.integration_writer`,
        `integration user is granted write on ${t}.* via x.integration_reader`,
      ]),
    );
  });
});
