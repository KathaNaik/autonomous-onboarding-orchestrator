import { z } from "zod";

/** GitHub login rules: 1–39 alphanumerics or single hyphens, not starting/ending with a hyphen. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Organization logins follow the same rule; team slugs are lowercase slug text. */
export const GITHUB_TEAM_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The subset of a GitHub user the adapter reads. Other fields are ignored and never stored. */
export const GitHubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
  type: z.string(),
});
export type GitHubUser = z.infer<typeof GitHubUserSchema>;

export const GitHubOrganizationSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
});
export type GitHubOrganization = z.infer<typeof GitHubOrganizationSchema>;

/** Org membership: state `active` or `pending` (invitation not yet accepted). */
export const GitHubOrgMembershipSchema = z.object({
  state: z.string(),
  role: z.string(),
  organization: z.object({ login: z.string() }),
  user: GitHubUserSchema.pick({ id: true, login: true }),
});
export type GitHubOrgMembership = z.infer<typeof GitHubOrgMembershipSchema>;

export const GitHubTeamSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  name: z.string(),
  organization: z.object({ login: z.string() }).optional(),
});
export type GitHubTeam = z.infer<typeof GitHubTeamSchema>;

/** Team membership: role `member` or `maintainer`; state `active` or `pending`. */
export const GitHubTeamMembershipSchema = z.object({
  state: z.string(),
  role: z.string(),
});
export type GitHubTeamMembership = z.infer<typeof GitHubTeamMembershipSchema>;
