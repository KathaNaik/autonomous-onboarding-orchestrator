// Manual read-only connectivity check against the configured ServiceNow instance.
//   pnpm servicenow:check            # auth + table query
//   pnpm servicenow:check --schema   # also verify the table definition with the separate
//                                    # SERVICENOW_SCHEMA_USERNAME/PASSWORD account
// Reads SERVICENOW_* from the environment or the repo-root .env. Prints no credentials.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ServiceNowError,
  checkAccessRequestTable,
  checkIntegrationAccess,
  createServiceNowClient,
  loadServiceNowConfig,
} from "../index.js";
import { loadSchemaVerificationConfig } from "../schema-verification.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  const config = loadServiceNowConfig();
  const client = createServiceNowClient(config);
  const connectivity = await client.verifyConnectivity();
  const records = await client.queryAccessRequests({ limit: 5 });
  const report: Record<string, unknown> = {
    ok: true,
    connectivity,
    query: { returned: records.length, numbers: records.map((r) => r.number) },
  };
  if (process.argv.includes("--schema")) {
    // Separate, explicit schema-verification account (see schema-verification.ts).
    const schemaClient = createServiceNowClient(loadSchemaVerificationConfig());
    const description = await schemaClient.describeAccessRequestTable();
    const problems = checkAccessRequestTable(description);
    report.schema = {
      table: description.name,
      superClass: description.superClass,
      scope: description.scope,
      columns: description.columns
        .filter((c) => !c.name.startsWith("sys_"))
        .map((c) => ({
          name: c.name,
          type: c.internalType,
          maxLength: c.maxLength,
          mandatory: c.mandatory,
          unique: c.unique,
          default: c.defaultValue || undefined,
        })),
      choices: description.choices,
      problems,
    };
    // Least privilege of the integration account (read via the schema-verification account).
    const access = await schemaClient.describeAccessControls();
    const integrationRoles = await schemaClient.describeUserRoles(config.username);
    const accessProblems = checkIntegrationAccess(
      config.accessRequestTable,
      access,
      integrationRoles,
    );
    report.access = {
      integrationUser: config.username,
      integrationRoles,
      acls: access.acls.map(
        (a) =>
          `${a.operation} ${a.name} → ${a.roles.join(", ") || "(no role)"}${a.active ? "" : " (inactive)"}`,
      ),
      problems: accessProblems,
    };
    if (problems.length > 0 || accessProblems.length > 0) report.ok = false;
  }
  print(report);
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  print({ ok: false, error: err instanceof ServiceNowError ? err.toJSON() : String(err) });
  process.exitCode = 1;
}
