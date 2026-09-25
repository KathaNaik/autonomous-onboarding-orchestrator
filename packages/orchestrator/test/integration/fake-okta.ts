import { randomBytes } from "node:crypto";
import { OktaError, type OktaGroup, type OktaNewUser, type OktaUser } from "@aoo/okta";
import type { OktaGateway } from "../../src/index.js";

const id = (prefix: "00u" | "00g") =>
  prefix +
  randomBytes(24)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 17)
    .padEnd(17, "x");

export type WriteBehavior =
  | "ok"
  | "lost-after-write" // the write takes effect; the client sees an unknown outcome
  | "503-no-effect" // unknown outcome, but nothing happened
  | "429" // rate limited: provably not processed
  | "auth" // 401
  | { writeThenHold: Promise<void> } // takes effect immediately, then hangs (crash window)
  | { hold: Promise<void> }; // hangs, then behaves like "ok"

/** In-memory Okta double: exact login lookup, employeeNumber search, groups and memberships. */
export class FakeOkta implements OktaGateway {
  readonly users: OktaUser[] = [];
  readonly groups = new Map<string, OktaGroup>();
  readonly memberships = new Set<string>();
  readonly createBehaviors: WriteBehavior[] = [];
  readonly addBehaviors: WriteBehavior[] = [];
  creates = 0;
  adds = 0;
  reads = 0;

  seedGroup(name: string, type = "OKTA_GROUP"): string {
    const groupId = id("00g");
    this.groups.set(groupId, { id: groupId, type, profile: { name } });
    return groupId;
  }

  seedUser(profile: Partial<OktaUser["profile"]> & { login: string }, status = "ACTIVE"): OktaUser {
    const user: OktaUser = {
      id: id("00u"),
      status,
      profile: {
        email: profile.login,
        firstName: "Seed",
        lastName: "User",
        employeeNumber: null,
        ...profile,
      },
    };
    this.users.push(user);
    return user;
  }

  get totalCalls() {
    return this.creates + this.adds + this.reads;
  }

  private async behave(queue: WriteBehavior[], op: string, effect: () => void) {
    const b = queue.shift() ?? "ok";
    if (b === "429")
      throw new OktaError("RATE_LIMITED", op, "HTTP 429", {
        status: 429,
        retryable: true,
        notSent: true,
      });
    if (b === "auth") throw new OktaError("AUTHENTICATION_FAILED", op, "HTTP 401", { status: 401 });
    if (b === "503-no-effect")
      throw new OktaError("OUTCOME_UNKNOWN", op, "HTTP 503", { status: 503, retryable: true });
    if (typeof b === "object" && "hold" in b) await b.hold;
    effect();
    if (typeof b === "object" && "writeThenHold" in b) await b.writeThenHold;
    if (b === "lost-after-write")
      throw new OktaError("OUTCOME_UNKNOWN", op, "request timed out", { retryable: true });
  }

  async getUser(userId: string): Promise<OktaUser | null> {
    this.reads++;
    return structuredClone(this.users.find((u) => u.id === userId) ?? null);
  }

  async findUsersByExactIdentity({
    login,
    employeeNumber,
  }: {
    login: string;
    employeeNumber: string;
  }) {
    this.reads++;
    return structuredClone(
      this.users.filter(
        (u) =>
          u.profile.login.toLowerCase() === login.toLowerCase() ||
          u.profile.employeeNumber === employeeNumber,
      ),
    );
  }

  async createUser(profile: OktaNewUser): Promise<OktaUser> {
    this.creates++;
    let created: OktaUser | undefined;
    await this.behave(this.createBehaviors, "createUser", () => {
      if (this.users.some((u) => u.profile.login.toLowerCase() === profile.login.toLowerCase())) {
        throw new OktaError("BAD_REQUEST", "createUser", "HTTP 400 (E0000001)", {
          status: 400,
          oktaErrorCode: "E0000001",
        });
      }
      created = { id: id("00u"), status: "STAGED", profile: { ...profile } };
      this.users.push(created);
    });
    return structuredClone(created!);
  }

  async getGroup(groupId: string): Promise<OktaGroup | null> {
    this.reads++;
    return structuredClone(this.groups.get(groupId) ?? null);
  }

  async isUserInGroup(userId: string, groupId: string): Promise<boolean> {
    this.reads++;
    return this.memberships.has(`${groupId}:${userId}`);
  }

  async addUserToGroup(groupId: string, userId: string): Promise<void> {
    this.adds++;
    await this.behave(this.addBehaviors, "addUserToGroup", () =>
      this.memberships.add(`${groupId}:${userId}`),
    );
  }
}
