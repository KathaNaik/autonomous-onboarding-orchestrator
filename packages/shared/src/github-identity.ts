import { z } from "zod";

/**
 * GitHub login syntax: 1–39 characters, alphanumerics and single inner hyphens. Checked exactly:
 * no trimming, case folding or normalization. GitHub treats logins case-insensitively.
 */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The employee's GitHub username as recorded by HR/onboarding staff (M7B). The employee creates
 * the account with their work email and gives the username to HR; it is not an HRIS fact and not
 * employee self-service. It is the bootstrap identifier only: the backend resolves it exactly at
 * GitHub and links the immutable numeric user id. Never inferred from email, names or free text.
 */
export const GitHubIdentityClaimRequestSchema = z.strictObject({
  githubLogin: z
    .string()
    .min(1, "GitHub username is required")
    .max(39, "GitHub usernames are at most 39 characters")
    .regex(GITHUB_LOGIN_PATTERN, "not a valid GitHub username"),
});
export type GitHubIdentityClaimRequest = z.infer<typeof GitHubIdentityClaimRequestSchema>;

/** Operator-facing identity state: no provider ids, tokens, policy or provider payloads. */
export const GITHUB_IDENTITY_STATES = ["NOT_SUBMITTED", "SUBMITTED", "RESOLVED"] as const;

/** Per-resource GitHub progress for the HR view. */
export const GITHUB_RESOURCE_PROGRESS = [
  "AWAITING_APPROVAL",
  "WAITING_FOR_IDENTITY",
  "WAITING_TO_START",
  "IN_PROGRESS",
  "INVITATION_PENDING",
  "CONNECTED",
  "NEEDS_ATTENTION",
] as const;

export const GitHubIdentityStatusSchema = z.strictObject({
  workflowId: z.uuid(),
  /** HRIS-owned employee details HR needs to match the account (display only). */
  employee: z.strictObject({
    firstName: z.string(),
    lastName: z.string(),
    workEmail: z.string(),
  }),
  /** True while an authorized or approval-pending GitHub resource still needs a resolved identity. */
  identityRequired: z.boolean(),
  identity: z.strictObject({
    state: z.enum(GITHUB_IDENTITY_STATES),
    /** The login HR recorded, if any. */
    claimedLogin: z.string().nullable(),
    /** GitHub's canonical login for the linked account, once resolved. */
    resolvedLogin: z.string().nullable(),
  }),
  resources: z.array(
    z.strictObject({
      resourceId: z.string(),
      displayName: z.string(),
      progress: z.enum(GITHUB_RESOURCE_PROGRESS),
    }),
  ),
});
export type GitHubIdentityStatus = z.infer<typeof GitHubIdentityStatusSchema>;

export const GitHubIdentityClaimResponseSchema = GitHubIdentityStatusSchema.extend({
  /** False when the same login was already on record (idempotent resubmission). */
  changed: z.boolean(),
});
export type GitHubIdentityClaimResponse = z.infer<typeof GitHubIdentityClaimResponseSchema>;

export const GITHUB_IDENTITY_ERROR_CODES = [
  "OPERATOR_UNAUTHORIZED",
  "OPERATOR_ID_REQUIRED",
  "INVALID_PAYLOAD",
  "UNSUPPORTED_MEDIA_TYPE",
  "WORKFLOW_NOT_FOUND",
  "WORKFLOW_NOT_ACTIVE",
  "GITHUB_IDENTITY_ALREADY_LINKED",
  "INTERNAL_ERROR",
] as const;

export const GitHubIdentityErrorResponseSchema = z.strictObject({
  error: z.enum(GITHUB_IDENTITY_ERROR_CODES),
  message: z.string(),
});
export type GitHubIdentityErrorResponse = z.infer<typeof GitHubIdentityErrorResponseSchema>;
