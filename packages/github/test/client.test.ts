import { describe, expect, it } from "vitest";
import {
  GitHubError,
  createGitHubClient,
  loadGitHubConfig,
  loadGitHubTargets,
  redactGitHubText,
} from "../src/index.js";

const TOKEN = "ghp_TestTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
const API = "https://api.github.com";

type Route = (req: { url: URL; init: RequestInit }) => Response | Promise<Response>;

function clientWith(route: Route, maxRetries = 2) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] =
    [];
  const sleeps: number[] = [];
  const client = createGitHubClient(
    { apiUrl: API, token: TOKEN, timeoutMs: 50, maxRetries, retryBaseMs: 10 },
    {
      fetch: (async (input: string, init: RequestInit) => {
        const url = new URL(input);
        calls.push({
          method: init.method ?? "GET",
          path: url.pathname,
          headers: init.headers as Record<string, string>,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return route({ url, init });
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    },
  );
  return { client, calls, sleeps };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const membership = (state: string, role = "member") => ({
  state,
  role,
  organization: { login: "aoo-test-org" },
  user: { id: 42, login: "octo-fixture" },
});

async function githubError(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GitHubError) return err;
    throw err;
  }
  throw new Error("expected GitHubError");
}

describe("reads", () => {
  it("looks up exactly one login (never a search) with bearer auth and API headers", async () => {
    const { client, calls } = clientWith(() =>
      json(200, { id: 42, login: "octo-fixture", type: "User", email: "x@y" }),
    );
    const user = await client.getUserByLogin("octo-fixture");
    expect(user).toEqual({ id: 42, login: "octo-fixture", type: "User" });
    expect(calls[0]!.path).toBe("/users/octo-fixture");
    expect(calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    });
    expect(calls[0]!.headers["User-Agent"]).toBeTruthy();
  });

  it("reads users by immutable id and returns null for unknown accounts", async () => {
    const { client, calls } = clientWith(({ url }) =>
      url.pathname === "/user/42"
        ? json(200, { id: 42, login: "renamed", type: "User" })
        : json(404, {}),
    );
    expect((await client.getUserById(42))?.login).toBe("renamed");
    expect(await client.getUserByLogin("nobody-here")).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(["/user/42", "/users/nobody-here"]);
  });

  it("reports active, pending and missing org membership", async () => {
    let state: string | null = "active";
    const { client } = clientWith(() =>
      state ? json(200, membership(state)) : json(404, { message: "Not Found" }),
    );
    expect((await client.getOrgMembership("aoo-test-org", "octo-fixture"))?.state).toBe("active");
    state = "pending";
    expect((await client.getOrgMembership("aoo-test-org", "octo-fixture"))?.state).toBe("pending");
    state = null;
    expect(await client.getOrgMembership("aoo-test-org", "octo-fixture")).toBeNull();
  });

  it("reads teams and team memberships", async () => {
    const { client, calls } = clientWith(({ url }) =>
      url.pathname.endsWith("/memberships/octo-fixture")
        ? json(200, { state: "active", role: "member", url: "https://api.github.com/x" })
        : json(200, {
            id: 7,
            slug: "aoo-backend",
            name: "AOO Backend",
            organization: { login: "aoo-test-org" },
          }),
    );
    expect(await client.getTeam("aoo-test-org", "aoo-backend")).toMatchObject({
      id: 7,
      slug: "aoo-backend",
      name: "AOO Backend",
    });
    expect(await client.getTeamMembership("aoo-test-org", "aoo-backend", "octo-fixture")).toEqual({
      state: "active",
      role: "member",
    });
    expect(calls[1]!.path).toBe("/orgs/aoo-test-org/teams/aoo-backend/memberships/octo-fixture");
  });

  it("rejects malformed logins and slugs before any request", async () => {
    const { client, calls } = clientWith(() => json(200, {}));
    expect((await githubError(client.getUserByLogin("../admin"))).code).toBe("REQUEST_INVALID");
    expect((await githubError(client.getTeam("aoo-test-org", "Bad Slug"))).code).toBe(
      "REQUEST_INVALID",
    );
    expect((await githubError(client.getOrgMembership("aoo-test-org", "a--b"))).code).toBe(
      "REQUEST_INVALID",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("writes (member role only, never retried by the client)", () => {
  it("creates an org invitation with role member and returns its pending state", async () => {
    const { client, calls } = clientWith(() => json(200, membership("pending")));
    expect((await client.setOrgMembership("aoo-test-org", "octo-fixture")).state).toBe("pending");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/orgs/aoo-test-org/memberships/octo-fixture",
      body: { role: "member" },
    });
  });

  it("adds a team membership with role member", async () => {
    const { client, calls } = clientWith(() => json(200, { state: "active", role: "member" }));
    expect(await client.addTeamMembership("aoo-test-org", "aoo-backend", "octo-fixture")).toEqual({
      state: "active",
      role: "member",
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/orgs/aoo-test-org/teams/aoo-backend/memberships/octo-fixture",
      body: { role: "member" },
    });
  });

  it.each([
    [502, "OUTCOME_UNKNOWN", false, true],
    [429, "RATE_LIMITED", true, true],
    [401, "AUTHENTICATION_FAILED", false, false],
    [422, "BAD_REQUEST", false, false],
  ] as const)(
    "classifies a write answered %s as %s (notSent=%s)",
    async (status, code, notSent, retryable) => {
      const { client, calls } = clientWith(() => json(status, { message: `leaked ${TOKEN}` }));
      const err = await githubError(
        client.addTeamMembership("aoo-test-org", "aoo-backend", "octo-fixture"),
      );
      expect([err.code, err.notSent, err.retryable]).toEqual([code, notSent, retryable]);
      expect(calls).toHaveLength(1);
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain("leaked");
    },
  );

  it("treats a timed-out write as outcome unknown", async () => {
    const { client } = clientWith(
      ({ init }) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    expect((await githubError(client.setOrgMembership("aoo-test-org", "octo-fixture"))).code).toBe(
      "OUTCOME_UNKNOWN",
    );
  });
});

describe("retries and rate limits", () => {
  it("retries 429 honoring Retry-After", async () => {
    let n = 0;
    const { client, sleeps } = clientWith(() =>
      n++ === 0
        ? json(429, {}, { "retry-after": "2" })
        : json(200, { id: 1, login: "aoo-test-org" }),
    );
    expect((await client.getOrganization("aoo-test-org"))?.login).toBe("aoo-test-org");
    expect(sleeps).toEqual([2000]);
  });

  it("treats 403 with an exhausted quota as a rate limit (x-ratelimit-reset, capped at 10 s)", async () => {
    let n = 0;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { client, sleeps } = clientWith(() =>
      n++ === 0
        ? json(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })
        : json(200, { id: 1, login: "aoo-test-org" }),
    );
    await client.getOrganization("aoo-test-org");
    expect(sleeps).toEqual([10_000]);
  });

  it("retries 5xx reads with bounded attempts", async () => {
    const { client, calls } = clientWith(() => json(503, {}), 2);
    expect((await githubError(client.getOrganization("aoo-test-org"))).code).toBe("UNAVAILABLE");
    expect(calls).toHaveLength(3);
  });

  it("never retries authentication or permission failures", async () => {
    for (const status of [401, 403]) {
      const { client, calls } = clientWith(() => json(status, {}));
      const err = await githubError(client.getOrganization("aoo-test-org"));
      expect(err.code).toBe(status === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      expect(calls).toHaveLength(1);
    }
  });
});

describe("configuration, targets and redaction", () => {
  it("validates connection settings without echoing values", () => {
    expect(() => loadGitHubConfig({})).toThrow(/GITHUB_TOKEN/);
    try {
      loadGitHubConfig({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: "http://api.github.com" });
    } catch (err) {
      expect((err as Error).message).toMatch(/GITHUB_API_URL/);
      expect((err as Error).message).not.toContain(TOKEN);
    }
    expect(loadGitHubConfig({ GITHUB_TOKEN: TOKEN }).apiUrl).toBe(API);
  });

  it("maps resources to explicit targets and refuses ambiguous or swapped configuration", () => {
    const env = {
      GITHUB_ORG: "aoo-test-org",
      GITHUB_BACKEND_TEAM_SLUG: "aoo-backend",
      GITHUB_BACKEND_TEAM_NAME: "AOO Backend",
      GITHUB_FRONTEND_TEAM_SLUG: "aoo-frontend",
      GITHUB_FRONTEND_TEAM_NAME: "AOO Frontend",
    };
    const targets = loadGitHubTargets(env);
    expect(targets.get("github-org-membership")).toEqual({
      kind: "org",
      resourceId: "github-org-membership",
      org: "aoo-test-org",
    });
    expect(targets.get("github-team-backend")).toMatchObject({
      teamSlug: "aoo-backend",
      teamName: "AOO Backend",
    });
    expect(targets.get("github-team-frontend")).toMatchObject({
      teamSlug: "aoo-frontend",
      teamName: "AOO Frontend",
    });
    expect(() => loadGitHubTargets({ ...env, GITHUB_FRONTEND_TEAM_SLUG: "aoo-backend" })).toThrow(
      /same team/,
    );
    expect(() => loadGitHubTargets({ ...env, GITHUB_BACKEND_TEAM_NAME: "" })).toThrow(
      /GITHUB_BACKEND_TEAM_NAME/,
    );
    expect(loadGitHubTargets({}).size).toBe(0);
    expect(() => loadGitHubTargets({ GITHUB_ORG: "not an org" })).toThrow(/GITHUB_ORG/);
  });

  it("redacts GitHub tokens, bearer values, URL queries and given values", () => {
    const out = redactGitHubText(
      `Authorization: Bearer ${TOKEN} github_pat_11ABCDEFG0123456789_abcdefghijklmnop token abcdefghijk https://api.github.com/x?access_token=zzz FIXTURE-LOGIN-1`,
      ["FIXTURE-LOGIN-1"],
    );
    expect(out).not.toMatch(
      new RegExp(`${TOKEN}|github_pat_11|abcdefghijk|access_token=zzz|FIXTURE-LOGIN-1`),
    );
  });
});
