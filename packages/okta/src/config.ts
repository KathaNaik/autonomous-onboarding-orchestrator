import { z } from "zod";
import { OktaError } from "./errors.js";
import { OKTA_GROUP_ID } from "./schemas.js";

const OktaConfigSchema = z.object({
  OKTA_BASE_URL: z
    .url()
    .refine((u) => {
      const url = new URL(u);
      return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.username;
    }, "must be an https origin such as https://dev-123456.okta.com")
    .transform((u) => new URL(u).origin),
  OKTA_API_TOKEN: z.string().min(20),
  OKTA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  OKTA_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OKTA_RETRY_BASE_MS: z.coerce.number().int().min(10).max(5000).default(250),
});

export interface OktaConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

/** Reads the Okta connection settings. Errors name the variable, never its value. */
export function loadOktaConfig(env: Record<string, string | undefined> = process.env): OktaConfig {
  const parsed = OktaConfigSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new OktaError("CONFIG_INVALID", "config", `invalid or missing ${names}`);
  }
  return {
    baseUrl: parsed.data.OKTA_BASE_URL,
    apiToken: parsed.data.OKTA_API_TOKEN,
    timeoutMs: parsed.data.OKTA_TIMEOUT_MS,
    maxRetries: parsed.data.OKTA_MAX_RETRIES,
    retryBaseMs: parsed.data.OKTA_RETRY_BASE_MS,
  };
}

/**
 * Deployment-specific Okta group targets for OKTA catalog resources. The released catalog holds
 * the logical resource; the org-specific group id lives here (environment configuration), never
 * in an immutable catalog release. Every entry is explicit: a resource without a configured
 * target is not provisioned, and no group is ever discovered by name.
 */
export const OKTA_GROUP_TARGET_ENV: Readonly<Record<string, { id: string; name: string }>> =
  Object.freeze({
    "okta-engineering-group": {
      id: "OKTA_ENGINEERING_GROUP_ID",
      name: "OKTA_ENGINEERING_GROUP_NAME",
    },
    "jira-engineering": {
      id: "OKTA_JIRA_ENGINEERING_GROUP_ID",
      name: "OKTA_JIRA_ENGINEERING_GROUP_NAME",
    },
    // M14 (catalog 1.1.0): Slack (single sign-on) and AWS development (IAM Identity Center).
    "slack-engineering": {
      id: "OKTA_SLACK_ENGINEERING_GROUP_ID",
      name: "OKTA_SLACK_ENGINEERING_GROUP_NAME",
    },
    "aws-dev": {
      id: "OKTA_AWS_DEV_GROUP_ID",
      name: "OKTA_AWS_DEV_GROUP_NAME",
    },
  });

export interface OktaGroupTarget {
  readonly resourceId: string;
  readonly groupId: string;
  /** Exact group name to verify, when configured; otherwise the catalog's groupName is used. */
  readonly expectedName: string | null;
}

/**
 * Configured group targets by resource id. A malformed id is a configuration error (thrown);
 * an absent id simply leaves that resource unconfigured.
 */
export function loadOktaGroupTargets(
  env: Record<string, string | undefined> = process.env,
): ReadonlyMap<string, OktaGroupTarget> {
  const targets = new Map<string, OktaGroupTarget>();
  for (const [resourceId, vars] of Object.entries(OKTA_GROUP_TARGET_ENV)) {
    const groupId = env[vars.id]?.trim();
    if (!groupId) continue;
    if (!OKTA_GROUP_ID.test(groupId)) {
      throw new OktaError("CONFIG_INVALID", "config", `${vars.id} is not an Okta group id`);
    }
    const expectedName = env[vars.name]?.trim() || null;
    targets.set(resourceId, Object.freeze({ resourceId, groupId, expectedName }));
  }
  return targets;
}
