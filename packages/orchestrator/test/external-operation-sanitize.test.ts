import { GitHubError } from "@aoo/github";
import { OktaError } from "@aoo/okta";
import { ServiceNowAuthError, ServiceNowOutcomeUnknownError } from "@aoo/servicenow";
import { describe, expect, it } from "vitest";
import { serviceNowAccessRequestKeys } from "../src/external-operations/keys.js";
import {
  formatSanitizedError,
  sanitizeExternalError,
  scrubText,
} from "../src/external-operations/sanitize.js";

describe("serviceNowAccessRequestKeys", () => {
  const id = {
    workflowId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    resourceId: "github:team:x",
    requestedEntitlement: "member",
  };

  it("is deterministic and query-safe", () => {
    const a = serviceNowAccessRequestKeys(id);
    expect(serviceNowAccessRequestKeys({ ...id })).toEqual(a);
    expect(a.idempotencyKey).toBe(
      `servicenow.create_access_request:${id.workflowId}:github:team:x:member`,
    );
    expect(a.correlationKey).toMatch(/^aoo-oar-[0-9a-f]{40}$/);
    expect(a.correlationKey).not.toContain("github");
  });

  it("differs per resource/entitlement/workflow and honors the prefix", () => {
    const base = serviceNowAccessRequestKeys(id).correlationKey;
    expect(
      serviceNowAccessRequestKeys({ ...id, resourceId: "github:team:y" }).correlationKey,
    ).not.toBe(base);
    expect(
      serviceNowAccessRequestKeys({ ...id, requestedEntitlement: "admin" }).correlationKey,
    ).not.toBe(base);
    expect(serviceNowAccessRequestKeys(id, "aoo-test-oar-").correlationKey).toMatch(
      /^aoo-test-oar-/,
    );
  });
});

describe("sanitizeExternalError", () => {
  const secrets = {
    password: "Pa55w0rd-Secret!",
    basic: "Basic YWRtaW46UGE1NXcwcmQtU2VjcmV0IQ==",
    bearer: "Bearer eyJhbGciOi.payload.sig",
    employee: "HRIS-EMP-99871",
    reason: "Needs access because of medical leave coverage",
  };
  const nasty = new Error(
    [
      `Authorization: ${secrets.basic}`,
      `authorization: ${secrets.bearer}`,
      `https://aoo.integration:${secrets.password}@dev1.service-now.com/api/now/table/x?sysparm_query=employee_id=${secrets.employee}`,
      `password=${secrets.password}`,
      `Cookie: JSESSIONID=abc123; glide_user_route=xyz`,
      `employee ${secrets.employee} reason ${secrets.reason}`,
      `Failed query: insert into "workflow_steps" params: ${secrets.employee},${secrets.reason}`,
    ].join(" | "),
  );

  it("removes credentials, cookies, query strings, SQL params and sensitive payload values", () => {
    const s = sanitizeExternalError(nasty, {
      provider: "servicenow",
      correlationKey: "aoo-oar-abc",
      sensitiveValues: [secrets.employee, secrets.reason],
    });
    const text = JSON.stringify(s) + formatSanitizedError(s);
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).not.toContain("JSESSIONID=abc123");
    expect(s).toMatchObject({
      provider: "servicenow",
      category: "INTERNAL",
      correlationKey: "aoo-oar-abc",
    });
    expect(s.message.length).toBeLessThanOrEqual(301);
  });

  it("keeps provider, status, code, category and correlation key for ServiceNow errors", () => {
    expect(
      sanitizeExternalError(new ServiceNowAuthError("createAccessRequest"), {
        provider: "servicenow",
        correlationKey: "k",
      }),
    ).toMatchObject({
      provider: "servicenow",
      category: "AUTHENTICATION",
      code: "AUTHENTICATION_FAILED",
      httpStatus: 401,
      operation: "createAccessRequest",
      correlationKey: "k",
      retryable: false,
    });
    const unknown = sanitizeExternalError(
      new ServiceNowOutcomeUnknownError("createAccessRequest", "instance returned 503", {
        status: 503,
      }),
      {
        provider: "servicenow",
      },
    );
    expect(unknown).toMatchObject({
      category: "OUTCOME_UNKNOWN",
      code: "OUTCOME_UNKNOWN",
      httpStatus: 503,
      retryable: true,
    });
    expect(formatSanitizedError(unknown)).toBe(
      "servicenow:OUTCOME_UNKNOWN (503): ServiceNow createAccessRequest: outcome unknown: instance returned 503",
    );
  });

  it("never includes the cause chain", () => {
    const err = new Error("wrapper", { cause: new Error(`inner ${secrets.password}`) });
    expect(JSON.stringify(sanitizeExternalError(err, { provider: "okta" }))).not.toContain(
      secrets.password,
    );
  });

  it("scrubText handles non-string sensitive values safely", () => {
    expect(scrubText("value ab kept", ["ab"])).toBe("value ab kept"); // <3 chars ignored
  });
});

describe("Okta error sanitization (M7A)", () => {
  const token = "00OktaApiToken_SECRETSECRETSECRETSECRET01";

  it("never persists an Okta API token, Authorization header or bearer value", () => {
    const fromOkta = sanitizeExternalError(
      new OktaError(
        "AUTHENTICATION_FAILED",
        "getUser",
        `HTTP 401 Authorization: SSWS ${token} bearer eyJhbGciOi.abc.def`,
        { status: 401, oktaErrorCode: "E0000011" },
      ),
      { provider: "okta", sensitiveValues: [token] },
    );
    expect(fromOkta).toMatchObject({
      provider: "okta",
      category: "AUTHENTICATION",
      code: "AUTHENTICATION_FAILED:E0000011",
      httpStatus: 401,
      retryable: false,
    });
    const unexpected = sanitizeExternalError(
      new Error(`socket closed; request had header SSWS ${token} and body {"secret":"x"}`),
      { provider: "okta" },
    );
    for (const e of [fromOkta, unexpected]) {
      const text = JSON.stringify(e) + formatSanitizedError(e);
      expect(text).not.toContain(token);
      expect(text).not.toContain("eyJhbGciOi");
    }
    expect(unexpected.message).toContain("SSWS [REDACTED]");
  });

  it.each([
    ["RATE_LIMITED", "PROVIDER_UNAVAILABLE"],
    ["OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
    ["PERMISSION_DENIED", "PERMISSION"],
    ["BAD_REQUEST", "VALIDATION"],
  ] as const)("maps Okta %s to category %s", (code, category) => {
    expect(
      sanitizeExternalError(new OktaError(code, "op", "x"), { provider: "okta" }).category,
    ).toBe(category);
  });
});

describe("GitHub error sanitization (M7B)", () => {
  const classic = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const fineGrained =
    "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

  it("never persists GITHUB_TOKEN values, Authorization headers or bearer values", () => {
    const fromGitHub = sanitizeExternalError(
      new GitHubError(
        "AUTHENTICATION_FAILED",
        "setOrgMembership",
        `HTTP 401 Authorization: Bearer ${classic} GITHUB_TOKEN=${fineGrained}`,
        { status: 401 },
      ),
      { provider: "github" },
    );
    expect(fromGitHub).toMatchObject({
      provider: "github",
      category: "AUTHENTICATION",
      httpStatus: 401,
      retryable: false,
    });
    const unexpected = sanitizeExternalError(
      new Error(`socket closed; header Authorization: token ${classic}; also ${fineGrained}`),
      { provider: "github" },
    );
    for (const e of [fromGitHub, unexpected]) {
      const text = JSON.stringify(e) + formatSanitizedError(e);
      expect(text).not.toContain(classic);
      expect(text).not.toContain(fineGrained);
      expect(text).not.toContain("A1b2C3d4");
    }
  });

  it.each([
    ["RATE_LIMITED", "PROVIDER_UNAVAILABLE"],
    ["OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
    ["PERMISSION_DENIED", "PERMISSION"],
  ] as const)("maps GitHub %s to category %s", (code, category) => {
    expect(
      sanitizeExternalError(new GitHubError(code, "op", "x"), { provider: "github" }).category,
    ).toBe(category);
  });
});
