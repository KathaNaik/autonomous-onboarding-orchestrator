// LIVE test against a real ServiceNow PDI. Never part of `pnpm test` / `pnpm test:integration`.
// Run explicitly: `pnpm test:servicenow:live` (reads SERVICENOW_* from the env or repo-root .env).
// Read-only: issues GET requests only.
import { beforeAll, describe, expect, it } from "vitest";
import {
  ServiceNowAuthError,
  checkAccessRequestTable,
  checkIntegrationAccess,
  createServiceNowClient,
  loadServiceNowConfig,
  type ServiceNowClient,
  type ServiceNowConfig,
} from "../../src/index.js";
import { loadSchemaVerificationConfig } from "../../src/schema-verification.js";

let config: ServiceNowConfig;
let client: ServiceNowClient;

beforeAll(() => {
  try {
    config = loadServiceNowConfig(process.env);
  } catch (err) {
    throw new Error(
      `BLOCKED: ServiceNow live test is not configured. Set SERVICENOW_INSTANCE_URL, SERVICENOW_USERNAME, ` +
        `SERVICENOW_PASSWORD and SERVICENOW_ACCESS_REQUEST_TABLE (see packages/servicenow/servicenow-app/SETUP.md). ` +
        `Details: ${(err as Error).message}`,
    );
  }
  client = createServiceNowClient(config);
});

describe("ServiceNow PDI (live, read-only)", () => {
  it("authenticates and reaches the access-request table", async () => {
    const result = await client.verifyConnectivity();
    expect(result.instanceUrl).toBe(config.instanceUrl);
    expect(result.table).toBe(config.accessRequestTable);
    expect(result.sampleCount).toBeGreaterThanOrEqual(0);
    console.info(
      `[live] authenticated to ${result.instanceUrl} as ${result.username} (${result.latencyMs} ms)`,
    );
  });

  it("queries the custom table and returns schema-valid records", async () => {
    const records = await client.queryAccessRequests({ limit: 10 });
    expect(Array.isArray(records)).toBe(true);
    for (const r of records) {
      expect(r.sysId).toMatch(/^[0-9a-f]{32}$/);
      expect(r.sysClassName).toBe(config.accessRequestTable);
    }
    console.info(`[live] ${records.length} access request(s) visible`);
  });

  it("reads a record by sys_id when one exists, and returns null for an unknown sys_id", async () => {
    const [first] = await client.queryAccessRequests({ limit: 1 });
    if (first) {
      const fetched = await client.getAccessRequest(first.sysId);
      expect(fetched).toEqual(first);
    } else {
      console.info("[live] table is empty: by-sys_id read of an existing record not exercised");
    }
    expect(await client.getAccessRequest("0".repeat(32))).toBeNull();
  });

  it("table extends Task and has the required columns", async () => {
    // Separate schema-verification account; never falls back to the integration account.
    let schemaConfig: ServiceNowConfig;
    try {
      schemaConfig = loadSchemaVerificationConfig(process.env);
    } catch (err) {
      throw new Error(
        `BLOCKED: schema verification needs SERVICENOW_SCHEMA_USERNAME/PASSWORD. ${(err as Error).message}`,
      );
    }
    const schemaClient = createServiceNowClient(schemaConfig);
    const description = await schemaClient.describeAccessRequestTable();
    expect(checkAccessRequestTable(description)).toEqual([]);
    expect(description.superClass).toBe("task");
    expect(description.columns.find((c) => c.name === "correlation_key")?.unique).toBe(true);
    expect(description.choices.policy_decision?.sort()).toEqual([
      "allow",
      "deny",
      "pending",
      "requires_approval",
    ]);
  });

  it("integration account is least-privilege: read + create, no delete/write, no admin", async () => {
    const schemaClient = createServiceNowClient(loadSchemaVerificationConfig(process.env));
    const access = await schemaClient.describeAccessControls();
    const roles = await schemaClient.describeUserRoles(config.username);
    console.info(`[live] ${config.username} roles: ${roles.join(", ")}`);
    expect(checkIntegrationAccess(config.accessRequestTable, access, roles)).toEqual([]);
  });

  it("rejects wrong credentials with ServiceNowAuthError", async () => {
    const wrong = createServiceNowClient({
      ...config,
      password: `${config.password}-wrong`,
      maxRetries: 0,
    });
    await expect(wrong.verifyConnectivity()).rejects.toBeInstanceOf(ServiceNowAuthError);
  });
});
