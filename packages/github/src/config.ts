import { z } from "zod";
import { GitHubError } from "./errors.js";
import { GITHUB_LOGIN, GITHUB_TEAM_SLUG } from "./schemas.js";

const GitHubConfigSchema = z.object({
  GITHUB_TOKEN: z.string().min(20),
  GITHUB_API_URL: z
    .url()
    .refine((u) => {
      const url = new URL(u);
      return url.protocol === "https:" && !url.search && !url.username;
    }, "must be an https URL")
    .transform((u) => u.replace(/\/+$/, ""))
    .default("https://api.github.com"),
  GITHUB_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  GITHUB_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  GITHUB_RETRY_BASE_MS: z.coerce.number().int().min(10).max(5000).default(250),
});

export interface GitHubConfig {
  apiUrl: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

/** Reads the GitHub connection settings. Errors name the variable, never its value. */
export function loadGitHubConfig(
  env: Record<string, string | undefined> = process.env,
): GitHubConfig {
  const parsed = GitHubConfigSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new GitHubError("CONFIG_INVALID", "config", `invalid or missing ${names}`);
  }
  return {
    apiUrl: parsed.data.GITHUB_API_URL,
    token: parsed.data.GITHUB_TOKEN,
    timeoutMs: parsed.data.GITHUB_TIMEOUT_MS,
    maxRetries: parsed.data.GITHUB_MAX_RETRIES,
    retryBaseMs: parsed.data.GITHUB_RETRY_BASE_MS,
  };
}

/** Where a GITHUB catalog resource is provisioned (deployment configuration, not catalog data). */
export type GitHubTarget =
  | { readonly kind: "org"; readonly resourceId: string; readonly org: string }
  | {
      readonly kind: "team";
      readonly resourceId: string;
      readonly org: string;
      readonly teamSlug: string;
      /** Exact expected team name; verified against GitHub before any write. */
      readonly teamName: string;
    };

/** Explicit resource → environment variable mapping. Nothing is discovered by name. */
export const GITHUB_TEAM_TARGET_ENV: Readonly<Record<string, { slug: string; name: string }>> =
  Object.freeze({
    "github-team-backend": { slug: "GITHUB_BACKEND_TEAM_SLUG", name: "GITHUB_BACKEND_TEAM_NAME" },
    "github-team-frontend": {
      slug: "GITHUB_FRONTEND_TEAM_SLUG",
      name: "GITHUB_FRONTEND_TEAM_NAME",
    },
  });
export const GITHUB_ORG_RESOURCE = "github-org-membership";

/**
 * Configured GitHub targets by resource id. `GITHUB_ORG` backs github-org-membership and every
 * team. A team needs both a slug and an exact name; two resources may never share a team.
 */
export function loadGitHubTargets(
  env: Record<string, string | undefined> = process.env,
): ReadonlyMap<string, GitHubTarget> {
  const targets = new Map<string, GitHubTarget>();
  const org = env.GITHUB_ORG?.trim();
  if (!org) return targets;
  if (!GITHUB_LOGIN.test(org)) {
    throw new GitHubError(
      "CONFIG_INVALID",
      "config",
      "GITHUB_ORG is not a GitHub organization login",
    );
  }
  targets.set(
    GITHUB_ORG_RESOURCE,
    Object.freeze({ kind: "org", resourceId: GITHUB_ORG_RESOURCE, org }),
  );
  const seen = new Map<string, string>();
  for (const [resourceId, vars] of Object.entries(GITHUB_TEAM_TARGET_ENV)) {
    const teamSlug = env[vars.slug]?.trim();
    const teamName = env[vars.name]?.trim();
    if (!teamSlug && !teamName) continue;
    if (!teamSlug || !GITHUB_TEAM_SLUG.test(teamSlug)) {
      throw new GitHubError(
        "CONFIG_INVALID",
        "config",
        `${vars.slug} is missing or not a team slug`,
      );
    }
    if (!teamName) {
      throw new GitHubError(
        "CONFIG_INVALID",
        "config",
        `${vars.name} is required with ${vars.slug}`,
      );
    }
    const other = seen.get(teamSlug);
    if (other) {
      throw new GitHubError(
        "CONFIG_INVALID",
        "config",
        `${vars.slug} targets the same team as ${other}`,
      );
    }
    seen.set(teamSlug, vars.slug);
    targets.set(resourceId, Object.freeze({ kind: "team", resourceId, org, teamSlug, teamName }));
  }
  return targets;
}
