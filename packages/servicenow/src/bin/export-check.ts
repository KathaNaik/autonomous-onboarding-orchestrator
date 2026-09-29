// M7D MANDATORY pre-export check: `pnpm servicenow:export:check [--file <update-set.xml>]`.
// Read-only. Without --file: scans the PDI's publish sources for the scoped app (update records,
// deleted-file records, scoped properties). With --file: scans a downloaded export before it is
// committed. Prints categories and COUNTS only; exits non-zero on any finding.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ServiceNowError, createServiceNowClient, loadServiceNowConfig } from "../index.js";
import { exportedRecordNames, scanExportText, scanUpdateRecords } from "../export-scan.js";
import { loadSchemaVerificationConfig } from "../schema-verification.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

// Every secret the project knows about; values never leave this process.
const SECRET_VARS = [
  "SERVICENOW_PASSWORD",
  "SERVICENOW_SCHEMA_PASSWORD",
  "SERVICENOW_FULFILLER_PASSWORD",
  "SERVICENOW_CALLBACK_SECRET",
  "HRIS_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "OKTA_API_TOKEN",
  "ONBOARDING_ADMIN_TOKEN",
];
const secrets = SECRET_VARS.flatMap((name) => {
  const value = process.env[name]?.trim();
  return value ? [{ name, value }] : [];
});

try {
  const config = loadServiceNowConfig();
  const table = config.accessRequestTable;
  const fileArg = process.argv.indexOf("--file");
  if (fileArg > 0) {
    const path = process.argv[fileArg + 1]!;
    const xml = readFileSync(path, "utf8");
    const names = exportedRecordNames(xml);
    const findings = [
      ...scanExportText(xml, secrets),
      ...scanUpdateRecords(
        names.map((name) => ({ name })),
        table,
      ),
    ];
    print({
      mode: "file",
      file: path.split("/").pop(),
      secretValuesChecked: secrets.map((s) => s.name),
      records: names.length,
      findings,
      clean: findings.length === 0,
    });
    process.exitCode = findings.length === 0 ? 0 : 1;
  } else {
    const scope = table.replace(/_onboarding_access_request$/, "");
    const admin = createServiceNowClient(loadSchemaVerificationConfig());
    const sources = await admin.readPublishSources(scope);
    const text = [
      ...sources.updates.map((u) => u.payload),
      ...sources.deletes.map((d) => d.payload),
    ].join("\n");
    const findings = [
      ...scanExportText(text, secrets),
      ...scanUpdateRecords([...sources.updates, ...sources.deletes], table),
      ...(sources.scopedProperties > 0
        ? [{ category: "scoped_property_record", count: sources.scopedProperties }]
        : []),
    ];
    print({
      mode: "pdi-publish-sources",
      scope,
      updateRecords: sources.updates.length,
      deletedFileRecords: sources.deletes.length,
      scopedProperties: sources.scopedProperties,
      secretValuesChecked: secrets.map((s) => s.name),
      findings,
      clean: findings.length === 0,
    });
    process.exitCode = findings.length === 0 ? 0 : 1;
  }
} catch (err) {
  print({ clean: false, error: err instanceof ServiceNowError ? err.toJSON() : String(err) });
  process.exitCode = 1;
}
