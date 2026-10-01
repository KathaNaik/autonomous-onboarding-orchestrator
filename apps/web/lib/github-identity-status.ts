import type { GitHubIdentityStatus } from "@aoo/shared";

/** HR-facing status: "Not provided", resolved, invitation pending or provisioned. */
export function statusLines(status: GitHubIdentityStatus): string[] {
  const lines: string[] = [];
  if (status.identity.state === "NOT_SUBMITTED") lines.push("Not provided");
  if (status.identity.state === "SUBMITTED") {
    lines.push(`Username recorded: ${status.identity.claimedLogin} (not yet resolved at GitHub)`);
  }
  if (status.identity.state === "RESOLVED") {
    lines.push(`Account resolved: ${status.identity.resolvedLogin}`);
  }
  for (const r of status.resources) {
    if (r.progress === "INVITATION_PENDING")
      lines.push(`${r.displayName}: Organization invitation pending`);
    if (r.progress === "CONNECTED") lines.push(`${r.displayName}: GitHub access provisioned`);
    if (r.progress === "NEEDS_ATTENTION") lines.push(`${r.displayName}: Needs attention`);
  }
  return lines;
}

/** Outcome notices shown after the form handler redirects back (fixed texts only). */
export const RESULT_MESSAGES: Record<string, string> = {
  saved: "GitHub account saved.",
  unchanged: "No change: this username is already recorded.",
  INVALID_PAYLOAD: "That is not a valid GitHub username.",
  GITHUB_IDENTITY_ALREADY_LINKED:
    "The employee is already linked to another GitHub account. Changing it needs administrator remediation.",
  WORKFLOW_NOT_ACTIVE: "This onboarding has ended; the username can no longer be changed.",
  WORKFLOW_NOT_FOUND: "Onboarding not found.",
  OPERATOR_UNAUTHORIZED: "Unauthorized.",
  INTERNAL_ERROR: "The onboarding service could not save the username. Try again.",
};
