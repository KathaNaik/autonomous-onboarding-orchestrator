// Setup/live-test verification ONLY (M7D). Deliberately NOT exported from the package index:
// runtime code can never load the synthetic human fulfiller's credentials. Imported only by
// src/bin/fulfillment-check.ts (username only) and the explicit live fulfillment test.
import { z } from "zod";
import { loadServiceNowConfig, type ServiceNowConfig } from "./config.js";
import { ServiceNowConfigError } from "./errors.js";

const FulfillerSchema = z.object({
  SERVICENOW_FULFILLER_USERNAME: z.string().trim().min(1, "is required"),
  SERVICENOW_FULFILLER_PASSWORD: z.string().min(1, "is required"),
});

/** Same instance/table as the runtime config, authenticated as the synthetic fulfiller. */
export function loadFulfillerConfig(env: NodeJS.ProcessEnv = process.env): ServiceNowConfig {
  const base = loadServiceNowConfig(env);
  const parsed = FulfillerSchema.safeParse(env);
  if (!parsed.success) {
    throw new ServiceNowConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    );
  }
  return {
    ...base,
    username: parsed.data.SERVICENOW_FULFILLER_USERNAME,
    password: parsed.data.SERVICENOW_FULFILLER_PASSWORD,
  };
}

/** The fulfiller's user name only (preflight role check; no password needed). */
export function fulfillerUsername(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SERVICENOW_FULFILLER_USERNAME?.trim() || null;
}
