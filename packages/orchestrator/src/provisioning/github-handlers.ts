import { createHash } from "node:crypto";
import { GitHubError, type GitHubClient, type GitHubOrgMembership } from "@aoo/github";
import { z } from "zod";
import type {
  ExternalOperationHandler,
  FailureClass,
  HandlerProbe,
} from "../external-operations/handler.js";

/** The GitHub calls provisioning needs; satisfied by GitHubClient (and by test doubles). */
export type GitHubGateway = Pick<
  GitHubClient,
  | "getUserByLogin"
  | "getUserById"
  | "getOrganization"
  | "getOrgMembership"
  | "setOrgMembership"
  | "getTeam"
  | "getTeamMembership"
  | "addTeamMembership"
>;

export const GITHUB_ENSURE_ORG_MEMBERSHIP = "github.ensure_org_membership";
export const GITHUB_ENSURE_TEAM_MEMBERSHIP = "github.ensure_team_membership";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);

/** One logical org-membership operation per authorized request, org and GitHub user id. */
export function githubOrgMembershipKeys(i: {
  accessDecisionId: string;
  accessRequestId: string;
  org: string;
  githubUserId: number;
}) {
  const idempotencyKey = `${GITHUB_ENSURE_ORG_MEMBERSHIP}:decision=${i.accessDecisionId}:request=${i.accessRequestId}:org=${i.org.toLowerCase()}:user=${i.githubUserId}`;
  return { idempotencyKey, correlationKey: `github-org:${digest(idempotencyKey)}` };
}

/** One logical team-membership operation per authorized request, team id and GitHub user id. */
export function githubTeamMembershipKeys(i: {
  accessDecisionId: string;
  accessRequestId: string;
  org: string;
  teamId: number;
  githubUserId: number;
}) {
  const idempotencyKey = `${GITHUB_ENSURE_TEAM_MEMBERSHIP}:decision=${i.accessDecisionId}:request=${i.accessRequestId}:org=${i.org.toLowerCase()}:team=${i.teamId}:user=${i.githubUserId}`;
  return { idempotencyKey, correlationKey: `github-team:${digest(idempotencyKey)}` };
}

const OrgRequestSchema = z.strictObject({
  accessRequestId: z.uuid(),
  accessDecisionId: z.uuid(),
  org: z.string().min(1),
  githubUserId: z.number().int().positive(),
  login: z.string().min(1),
});
export type GitHubOrgRequest = z.infer<typeof OrgRequestSchema>;

const TeamRequestSchema = z.strictObject({
  accessRequestId: z.uuid(),
  accessDecisionId: z.uuid(),
  org: z.string().min(1),
  teamId: z.number().int().positive(),
  teamSlug: z.string().min(1),
  teamName: z.string().min(1),
  githubUserId: z.number().int().positive(),
  login: z.string().min(1),
});
export type GitHubTeamRequest = z.infer<typeof TeamRequestSchema>;

export function classifyGitHubError(err: unknown): FailureClass {
  if (!(err instanceof GitHubError)) return "retry";
  if (err.notSent) return "not_sent";
  switch (err.code) {
    case "OUTCOME_UNKNOWN":
      return "outcome_unknown";
    case "AUTHENTICATION_FAILED":
    case "PERMISSION_DENIED":
    case "REQUEST_INVALID":
    case "CONFIG_INVALID":
    case "BAD_REQUEST":
    case "UNEXPECTED_REDIRECT":
      return "failed";
    default:
      return "retry";
  }
}

/** Membership state becomes the operation's externalReference: "active" or "pending". */
const satisfied = (externalId: string, state: "active" | "pending"): HandlerProbe => ({
  kind: "satisfied",
  externalId,
  externalReference: state,
});

function probeOrgMembership(m: GitHubOrgMembership | null, r: GitHubOrgRequest): HandlerProbe {
  if (!m) return { kind: "absent" };
  if (m.user.id !== r.githubUserId) {
    return {
      kind: "conflict",
      code: "GITHUB_IDENTITY_CONFLICT",
      message: "the org membership belongs to another GitHub user id",
      evidence: { expectedUserId: r.githubUserId, actualUserId: m.user.id },
    };
  }
  if (m.organization.login.toLowerCase() !== r.org.toLowerCase()) {
    return {
      kind: "conflict",
      code: "GITHUB_ORG_MISMATCH",
      message: "membership is for another organization",
    };
  }
  if (m.role !== "member") {
    // Never normalize or downgrade a higher privilege: report it.
    return {
      kind: "conflict",
      code: "GITHUB_UNEXPECTED_ROLE",
      message: "the user holds an unexpected organization role",
      evidence: { role: m.role },
    };
  }
  if (m.state === "active" || m.state === "pending") {
    return satisfied(`${r.org}/${r.githubUserId}`, m.state);
  }
  return {
    kind: "conflict",
    code: "GITHUB_UNEXPECTED_STATE",
    message: "unexpected membership state",
    evidence: { state: m.state },
  };
}

export function createGitHubOrgMembershipHandler(
  gh: GitHubGateway,
): ExternalOperationHandler<GitHubOrgRequest> {
  return {
    provider: "github",
    operationType: GITHUB_ENSURE_ORG_MEMBERSHIP,
    parseRequest: (raw) => OrgRequestSchema.parse(raw),
    sensitiveValues: () => [],
    async reconcile(r, { signal }) {
      const org = await gh.getOrganization(r.org, { signal });
      if (!org) {
        return {
          kind: "conflict",
          code: "GITHUB_ORG_NOT_FOUND",
          message: "the configured organization does not exist",
        };
      }
      return probeOrgMembership(await gh.getOrgMembership(r.org, r.login, { signal }), r);
    },
    // Ordinary member only; for a non-member GitHub creates a (pending) invitation.
    perform: (r, { signal }) => gh.setOrgMembership(r.org, r.login, { signal }),
    async verify(r, _performed, { signal }) {
      return probeOrgMembership(await gh.getOrgMembership(r.org, r.login, { signal }), r);
    },
    classify: classifyGitHubError,
  };
}

export function createGitHubTeamMembershipHandler(
  gh: GitHubGateway,
): ExternalOperationHandler<GitHubTeamRequest> {
  const probeTeam = async (r: GitHubTeamRequest, signal: AbortSignal): Promise<HandlerProbe> => {
    const tm = await gh.getTeamMembership(r.org, r.teamSlug, r.login, { signal });
    if (!tm) return { kind: "absent" };
    if (tm.role !== "member") {
      return {
        kind: "conflict",
        code: "GITHUB_UNEXPECTED_ROLE",
        message: "the user holds an unexpected team role",
        evidence: { role: tm.role, teamId: r.teamId },
      };
    }
    if (tm.state === "active" || tm.state === "pending") {
      return satisfied(`${r.teamId}/${r.githubUserId}`, tm.state);
    }
    return {
      kind: "conflict",
      code: "GITHUB_UNEXPECTED_STATE",
      message: "unexpected team membership state",
      evidence: { state: tm.state },
    };
  };
  return {
    provider: "github",
    operationType: GITHUB_ENSURE_TEAM_MEMBERSHIP,
    parseRequest: (raw) => TeamRequestSchema.parse(raw),
    sensitiveValues: () => [],
    async reconcile(r, { signal }) {
      // Exact target: the configured team, by id, slug and name. Never a similarly named team.
      const team = await gh.getTeam(r.org, r.teamSlug, { signal });
      if (!team) {
        return {
          kind: "conflict",
          code: "GITHUB_TEAM_NOT_FOUND",
          message: "the configured team does not exist",
          evidence: { teamSlug: r.teamSlug },
        };
      }
      if (team.id !== r.teamId || team.slug !== r.teamSlug || team.name !== r.teamName) {
        return {
          kind: "conflict",
          code: "GITHUB_TEAM_MISMATCH",
          message: "the team is not the expected target",
          evidence: { teamId: team.id },
        };
      }
      const org = await gh.getOrgMembership(r.org, r.login, { signal });
      if (!org || org.state !== "active" || org.user.id !== r.githubUserId) {
        return {
          kind: "conflict",
          code: "GITHUB_ORG_MEMBERSHIP_NOT_ACTIVE",
          message: "the user is not an active member of the organization",
        };
      }
      return probeTeam(r, signal);
    },
    perform: (r, { signal }) => gh.addTeamMembership(r.org, r.teamSlug, r.login, { signal }),
    verify: (r, _performed, { signal }) => probeTeam(r, signal),
    classify: classifyGitHubError,
  };
}

export function createGitHubHandlers(gh: GitHubGateway): ExternalOperationHandler[] {
  return [
    createGitHubOrgMembershipHandler(gh) as ExternalOperationHandler,
    createGitHubTeamMembershipHandler(gh) as ExternalOperationHandler,
  ];
}
