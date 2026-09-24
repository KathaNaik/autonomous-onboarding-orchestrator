// Setup-time verification ONLY. Deliberately NOT exported from the package index: normal
// runtime code (and anything importing "@aoo/servicenow") can never load admin credentials.
// Imported only by src/bin/check.ts (--schema) and the explicit live test.
import { z } from "zod";
import { loadServiceNowConfig, type ServiceNowConfig } from "./config.js";
import { ServiceNowConfigError } from "./errors.js";

const SchemaCredentialsSchema = z.object({
  SERVICENOW_SCHEMA_USERNAME: z.string().trim().min(1, "is required for schema verification"),
  SERVICENOW_SCHEMA_PASSWORD: z.string().min(1, "is required for schema verification"),
});

/**
 * Same instance/table/timeouts as the runtime config, but authenticated with the separate
 * schema-verification account (reads sys_db_object, sys_dictionary, sys_choice; usually admin).
 * Never falls back to the integration account and never reuses its credentials.
 */
export function loadSchemaVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceNowConfig {
  const base = loadServiceNowConfig(env);
  const parsed = SchemaCredentialsSchema.safeParse(env);
  if (!parsed.success) {
    throw new ServiceNowConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    );
  }
  return {
    ...base,
    username: parsed.data.SERVICENOW_SCHEMA_USERNAME,
    password: parsed.data.SERVICENOW_SCHEMA_PASSWORD,
  };
}
