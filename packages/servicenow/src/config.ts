import { z } from "zod";
import { ServiceNowConfigError } from "./errors.js";

const EnvSchema = z.object({
  SERVICENOW_INSTANCE_URL: z
    .url({ protocol: /^https$/, error: "must be an https:// URL" })
    .refine((u) => {
      const url = new URL(u);
      return (url.pathname === "/" || url.pathname === "") && !url.search && !url.username;
    }, "must be the instance origin only, e.g. https://dev12345.service-now.com")
    .transform((u) => new URL(u).origin),
  SERVICENOW_USERNAME: z.string().trim().min(1, "is required"),
  SERVICENOW_PASSWORD: z.string().min(1, "is required"),
  SERVICENOW_ACCESS_REQUEST_TABLE: z
    .string()
    .regex(
      /^x_[a-z0-9_]+$/,
      "must be the scoped table name, e.g. x_1234567_onboard_access_request",
    ),
  SERVICENOW_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  SERVICENOW_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  SERVICENOW_RETRY_BASE_MS: z.coerce.number().int().min(1).max(10_000).default(250),
});

export interface ServiceNowConfig {
  instanceUrl: string;
  username: string;
  password: string;
  accessRequestTable: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

/**
 * Parses SERVICENOW_* variables. On failure throws ServiceNowConfigError listing variable names
 * and problems only; values (including the password) are never echoed.
 */
export function loadServiceNowConfig(env: NodeJS.ProcessEnv = process.env): ServiceNowConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ServiceNowConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    );
  }
  const c = parsed.data;
  return {
    instanceUrl: c.SERVICENOW_INSTANCE_URL,
    username: c.SERVICENOW_USERNAME,
    password: c.SERVICENOW_PASSWORD,
    accessRequestTable: c.SERVICENOW_ACCESS_REQUEST_TABLE,
    timeoutMs: c.SERVICENOW_TIMEOUT_MS,
    maxRetries: c.SERVICENOW_MAX_RETRIES,
    retryBaseMs: c.SERVICENOW_RETRY_BASE_MS,
  };
}
