// M7D read-only preflight: `pnpm servicenow:fulfillment:check`. Makes NO writes. Verifies the
// integration account can authenticate/read and holds create (and no write/delete), the table has
// request_kind and fulfillment_state with exactly their choices, the fulfiller role and its
// field-level ACLs, the "AOO fulfillment callback" business rule, and (optionally) the synthetic
// fulfiller account's roles. Prints names, flags and problems only: never credentials.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FULFILLMENT_STATES,
  REQUEST_KINDS,
  ServiceNowError,
  checkAccessRequestTable,
  checkFulfillerAccess,
  checkIntegrationAccess,
  createServiceNowClient,
  fulfillerRoleFor,
  loadServiceNowConfig,
} from "../index.js";
import { fulfillerUsername, loadFulfillerConfig } from "../fulfiller-verification.js";
import { loadSchemaVerificationConfig } from "../schema-verification.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const ELEVATED = ["admin", "security_admin", "maint"];
// Newer releases store "async" business rules as "async_always".
const ASYNC = ["async", "async_always"];

try {
  const config = loadServiceNowConfig();
  const integration = createServiceNowClient(config);
  const connectivity = await integration.verifyConnectivity();
  // A read that matches nothing: proves read access without touching any record.
  await integration.queryAccessRequests({ correlationKey: "aoo-preflight-no-such-key", limit: 1 });

  const admin = createServiceNowClient(loadSchemaVerificationConfig());
  const table = config.accessRequestTable;
  const description = await admin.describeAccessRequestTable();
  const columns = new Set(description.columns.map((c) => c.name));
  const access = await admin.describeAccessControls();
  const integrationRoles = await admin.describeUserRoles(config.username);
  const role = fulfillerRoleFor(table);
  const roles = await admin.describeRoles([role]);
  const rules = await admin.describeBusinessRules();
  const rule = rules.find((r) => r.name === "AOO fulfillment callback");
  const approvalRule = rules.find((r) => r.name === "AOO approval callback");
  // Fulfiller authentication: one read with its own credentials (no write, nothing printed).
  let fulfillerAuth: { attempted: boolean; authenticated?: boolean; error?: string } = {
    attempted: false,
  };
  if (process.env.SERVICENOW_FULFILLER_PASSWORD) {
    try {
      await createServiceNowClient(loadFulfillerConfig()).queryAccessRequests({
        correlationKey: "aoo-preflight-no-such-key",
        limit: 1,
      });
      fulfillerAuth = { attempted: true, authenticated: true };
    } catch (err) {
      fulfillerAuth = {
        attempted: true,
        authenticated: false,
        error: err instanceof ServiceNowError ? err.code : "ERROR",
      };
    }
  }
  const fulfiller = fulfillerUsername();
  const fulfillerRoles = fulfiller ? await admin.describeUserRoles(fulfiller) : null;

  const problems = {
    schema: checkAccessRequestTable(description),
    integration: checkIntegrationAccess(table, access, integrationRoles),
    fulfillerRole: roles.includes(role)
      ? checkFulfillerAccess(table, access, role)
      : [`role ${role} does not exist`],
    businessRule: !rule
      ? ["business rule 'AOO fulfillment callback' not found on the table"]
      : [
          ...(rule.active ? [] : ["business rule is inactive"]),
          ...(ASYNC.includes(rule.when)
            ? []
            : [`business rule runs '${rule.when}', expected async`]),
          ...(rule.onUpdate ? [] : ["business rule doesn't run on update"]),
        ],
    approvalRule: !approvalRule
      ? ["business rule 'AOO approval callback' not found"]
      : [
          ...(approvalRule.active ? [] : ["approval callback rule is inactive"]),
          ...(ASYNC.includes(approvalRule.when) && approvalRule.onUpdate
            ? []
            : ["approval callback rule changed (expected async, on update)"]),
        ],
    fulfillerAuth:
      fulfillerAuth.attempted && !fulfillerAuth.authenticated
        ? [`fulfiller authentication failed (${fulfillerAuth.error})`]
        : [],
    fulfillerAccount: !fulfillerRoles
      ? []
      : [
          ...(fulfillerRoles.includes(role) ? [] : [`${fulfiller} doesn't hold ${role}`]),
          ...fulfillerRoles
            .filter((r) => ELEVATED.includes(r))
            .map((r) => `${fulfiller} holds elevated role ${r}`),
          ...fulfillerRoles
            .filter((r) => r.endsWith(".integration_writer"))
            .map((r) => `${fulfiller} holds the backend writer role ${r}`),
        ],
  };
  const ok = Object.values(problems).every((p) => p.length === 0);
  print({
    ok,
    writes: 0,
    connectivity: { instanceUrl: connectivity.instanceUrl, table, authenticated: true },
    fields: {
      request_kind: columns.has("request_kind"),
      fulfillment_state: columns.has("fulfillment_state"),
      requestKindChoices: description.choices.request_kind ?? [],
      fulfillmentStateChoices: description.choices.fulfillment_state ?? [],
      expected: { requestKind: REQUEST_KINDS, fulfillmentState: FULFILLMENT_STATES },
    },
    integrationUser: {
      name: config.username,
      roles: integrationRoles,
      canCreate: problems.integration.every((p) => !p.includes("create")),
    },
    fulfillerRole: { name: role, exists: roles.includes(role) },
    acls: access.acls
      .filter((a) => a.roles.includes(role) || (a.operation === "write" && a.name === `${table}.*`))
      .map(
        (a) =>
          `${a.operation} ${a.name} → ${a.roles.join(", ") || "(no role)"}${a.condition ? ` [condition: ${a.condition}]` : ""}${a.active ? "" : " (inactive)"}`,
      ),
    businessRule: rule ?? null,
    approvalRule: approvalRule ?? null,
    fulfillerAuth,
    fulfillerAccount: fulfiller
      ? { name: fulfiller, roles: fulfillerRoles }
      : { configured: false },
    problems,
  });
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  print({
    ok: false,
    writes: 0,
    error: err instanceof ServiceNowError ? err.toJSON() : String(err),
  });
  process.exitCode = 1;
}
