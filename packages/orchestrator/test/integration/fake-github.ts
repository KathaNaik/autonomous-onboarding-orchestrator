import {
  GitHubError,
  type GitHubOrgMembership,
  type GitHubTeam,
  type GitHubTeamMembership,
  type GitHubUser,
} from "@aoo/github";
import type { GitHubGateway } from "../../src/index.js";

export type GitHubWriteBehavior =
  | "ok"
  | "lost-after-write"
  | "503-no-effect"
  | "429"
  | "auth"
  | { writeThenHold: Promise<void> }
  | { hold: Promise<void> };

let nextId = 5000;

/** In-memory GitHub double: users, one org, org memberships (active/pending), teams, team memberships. */
export class FakeGitHub implements GitHubGateway {
  readonly users = new Map<number, GitHubUser>();
  readonly orgMembers = new Map<number, { state: string; role: string }>();
  readonly teams = new Map<string, GitHubTeam>();
  readonly teamMembers = new Map<string, { state: string; role: string }>();
  readonly orgWriteBehaviors: GitHubWriteBehavior[] = [];
  readonly teamWriteBehaviors: GitHubWriteBehavior[] = [];
  /** When true, an org PUT makes an ACTIVE member directly; otherwise it creates a pending invitation. */
  inviteActivates = false;
  writes = 0;
  reads = 0;
  readonly loginLookups: string[] = [];

  constructor(readonly org = "aoo-test-org") {}

  seedUser(login: string, type = "User"): GitHubUser {
    const user = { id: nextId++, login, type };
    this.users.set(user.id, user);
    return user;
  }
  seedTeam(slug: string, name: string): GitHubTeam {
    const team = { id: nextId++, slug, name, organization: { login: this.org } };
    this.teams.set(slug, team);
    return team;
  }
  acceptInvitation(userId: number) {
    const m = this.orgMembers.get(userId);
    if (m) m.state = "active";
  }

  private async behave(queue: GitHubWriteBehavior[], op: string, effect: () => void) {
    const b = queue.shift() ?? "ok";
    if (b === "429")
      throw new GitHubError("RATE_LIMITED", op, "HTTP 429", {
        status: 429,
        retryable: true,
        notSent: true,
      });
    if (b === "auth")
      throw new GitHubError("AUTHENTICATION_FAILED", op, "HTTP 401", { status: 401 });
    if (b === "503-no-effect")
      throw new GitHubError("OUTCOME_UNKNOWN", op, "HTTP 503", { status: 503, retryable: true });
    if (typeof b === "object" && "hold" in b) await b.hold;
    effect();
    if (typeof b === "object" && "writeThenHold" in b) await b.writeThenHold;
    if (b === "lost-after-write")
      throw new GitHubError("OUTCOME_UNKNOWN", op, "request timed out", { retryable: true });
  }

  private byLogin(login: string) {
    return [...this.users.values()].find((u) => u.login.toLowerCase() === login.toLowerCase());
  }

  async getUserByLogin(login: string) {
    this.reads++;
    this.loginLookups.push(login);
    const u = this.byLogin(login);
    return u ? { ...u } : null;
  }
  async getUserById(id: number) {
    this.reads++;
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async getOrganization(org: string) {
    this.reads++;
    return org === this.org ? { id: 1, login: this.org } : null;
  }
  async getOrgMembership(org: string, login: string): Promise<GitHubOrgMembership | null> {
    this.reads++;
    const u = this.byLogin(login);
    const m = u && org === this.org ? this.orgMembers.get(u.id) : undefined;
    return u && m
      ? { ...m, organization: { login: this.org }, user: { id: u.id, login: u.login } }
      : null;
  }
  async setOrgMembership(org: string, login: string): Promise<GitHubOrgMembership> {
    this.writes++;
    const u = this.byLogin(login)!;
    await this.behave(this.orgWriteBehaviors, "setOrgMembership", () => {
      if (!this.orgMembers.has(u.id))
        this.orgMembers.set(u.id, {
          state: this.inviteActivates ? "active" : "pending",
          role: "member",
        });
    });
    return {
      ...this.orgMembers.get(u.id)!,
      organization: { login: org },
      user: { id: u.id, login: u.login },
    };
  }
  async getTeam(org: string, slug: string) {
    this.reads++;
    const t = org === this.org ? this.teams.get(slug) : undefined;
    return t ? { ...t } : null;
  }
  async getTeamMembership(
    _org: string,
    slug: string,
    login: string,
  ): Promise<GitHubTeamMembership | null> {
    this.reads++;
    const u = this.byLogin(login);
    const m = u ? this.teamMembers.get(`${slug}:${u.id}`) : undefined;
    return m ? { ...m } : null;
  }
  async addTeamMembership(
    _org: string,
    slug: string,
    login: string,
  ): Promise<GitHubTeamMembership> {
    this.writes++;
    const u = this.byLogin(login)!;
    await this.behave(this.teamWriteBehaviors, "addTeamMembership", () => {
      if (!this.teamMembers.has(`${slug}:${u.id}`))
        this.teamMembers.set(`${slug}:${u.id}`, { state: "active", role: "member" });
    });
    return { ...this.teamMembers.get(`${slug}:${u.id}`)! };
  }
}
