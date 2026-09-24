import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import { loadServiceNowConfig } from "../src/config.js";
import { ServiceNowConfigError } from "../src/errors.js";
import { loadSchemaVerificationConfig } from "../src/schema-verification.js";

const runtimeEnv = {
  SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com",
  SERVICENOW_USERNAME: "aoo.integration",
  SERVICENOW_PASSWORD: "integration-secret",
  SERVICENOW_ACCESS_REQUEST_TABLE: "x_1234567_autonomo_onboarding_access_request",
};
const schemaEnv = {
  SERVICENOW_SCHEMA_USERNAME: "admin",
  SERVICENOW_SCHEMA_PASSWORD: "admin-secret",
};

describe("credential separation", () => {
  it("runtime config always uses the integration account, even when schema credentials are present", () => {
    const config = loadServiceNowConfig({ ...runtimeEnv, ...schemaEnv });
    expect(config.username).toBe("aoo.integration");
    expect(config.password).toBe("integration-secret");
    expect(JSON.stringify(config)).not.toContain("admin-secret");
  });

  it("runtime config never falls back to schema credentials", () => {
    const { SERVICENOW_USERNAME: _u, SERVICENOW_PASSWORD: _p, ...withoutIntegration } = runtimeEnv;
    expect(() => loadServiceNowConfig({ ...withoutIntegration, ...schemaEnv })).toThrow(
      ServiceNowConfigError,
    );
  });

  it("schema verification uses only the separate schema account", () => {
    const config = loadSchemaVerificationConfig({ ...runtimeEnv, ...schemaEnv });
    expect(config).toMatchObject({
      username: "admin",
      password: "admin-secret",
      instanceUrl: "https://dev12345.service-now.com",
      accessRequestTable: "x_1234567_autonomo_onboarding_access_request",
    });
  });

  it("schema verification refuses to run without schema credentials (no fallback to integration)", () => {
    expect(() => loadSchemaVerificationConfig(runtimeEnv)).toThrow(/SERVICENOW_SCHEMA_USERNAME/);
    expect(() =>
      loadSchemaVerificationConfig({
        ...runtimeEnv,
        SERVICENOW_SCHEMA_USERNAME: "admin",
        SERVICENOW_SCHEMA_PASSWORD: "",
      }),
    ).toThrow(/SERVICENOW_SCHEMA_PASSWORD/);
  });

  it("the schema loader is not part of the package's public API", () => {
    expect(Object.keys(publicApi)).not.toContain("loadSchemaVerificationConfig");
  });
});
