import { describe, expect, it } from "vitest";
import { loadConfig, loadWorkerServiceNowConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://aoo:aoo@localhost:5432/aoo" };
const sn = {
  SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com",
  SERVICENOW_USERNAME: "aoo.integration",
  SERVICENOW_PASSWORD: "integration-secret",
  SERVICENOW_ACCESS_REQUEST_TABLE: "x_1234567_autonomo_onboarding_access_request",
  SERVICENOW_SCHEMA_USERNAME: "aoo.schema.verifier",
  SERVICENOW_SCHEMA_PASSWORD: "admin-secret",
};

describe("worker ServiceNow configuration", () => {
  it("is disabled when no instance URL is set (empty strings from compose included)", () => {
    expect(loadWorkerServiceNowConfig(loadConfig(base), base)).toBeNull();
    expect(
      loadWorkerServiceNowConfig(loadConfig(base), { ...base, SERVICENOW_INSTANCE_URL: "  " }),
    ).toBeNull();
  });

  it("uses only the integration account, never schema/admin credentials", () => {
    const env = { ...base, ...sn, SERVICENOW_TIMEOUT_MS: "5000" };
    const config = loadWorkerServiceNowConfig(loadConfig(env), env)!;
    expect(config.username).toBe("aoo.integration");
    expect(JSON.stringify(config)).not.toContain("admin-secret");
    expect(JSON.stringify(config)).not.toContain("aoo.schema.verifier");
  });

  it("enforces 3 × SERVICENOW_TIMEOUT_MS ≤ 0.8 × OUTBOX_LEASE_MS", () => {
    const ok = { ...base, ...sn, OUTBOX_LEASE_MS: "30000", SERVICENOW_TIMEOUT_MS: "8000" };
    expect(loadWorkerServiceNowConfig(loadConfig(ok), ok)?.timeoutMs).toBe(8000);

    const tooSlow = { ...ok, SERVICENOW_TIMEOUT_MS: "8001" };
    expect(() => loadWorkerServiceNowConfig(loadConfig(tooSlow), tooSlow)).toThrow(
      /too long for OUTBOX_LEASE_MS/,
    );

    const longerLease = { ...tooSlow, OUTBOX_LEASE_MS: "60000" };
    expect(loadWorkerServiceNowConfig(loadConfig(longerLease), longerLease)?.timeoutMs).toBe(8001);
  });

  it("the ServiceNow default timeout (10s) does not fit the default 30s lease and is rejected loudly", () => {
    const env = { ...base, ...sn };
    expect(() => loadWorkerServiceNowConfig(loadConfig(env), env)).toThrow(
      /SERVICENOW_TIMEOUT_MS \(10000\)/,
    );
  });

  it("validates reconciliation settings", () => {
    expect(loadConfig(base)).toMatchObject({
      EXTERNAL_OP_RECONCILE_ATTEMPTS: 3,
      EXTERNAL_OP_RECONCILE_DELAY_MS: 1000,
    });
    expect(() => loadConfig({ ...base, EXTERNAL_OP_RECONCILE_ATTEMPTS: "0" })).toThrow();
  });
});
