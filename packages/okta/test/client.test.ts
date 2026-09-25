import { describe, expect, it } from "vitest";
import {
  OktaError,
  createOktaClient,
  loadOktaConfig,
  loadOktaGroupTargets,
  redactOktaText,
} from "../src/index.js";

const TOKEN = "00TestOktaApiToken_ABCDEFGHIJKLMNOPQRSTUV";
const BASE = "https://dev-000000.okta.com";
const USER = "00u1aaaaaaaaaaaaaaaa";
const OTHER = "00u2bbbbbbbbbbbbbbbb";
const GROUP = "00g1cccccccccccccccc";

const user = (id: string, login: string, employeeNumber: string | null) => ({
  id,
  status: "STAGED",
  profile: { login, email: login, firstName: "Syn", lastName: "Thetic", employeeNumber },
  _links: { secret: "ignored" },
});

type Route = (req: { url: URL; init: RequestInit }) => Response | Promise<Response>;

function clientWith(route: Route, opts: { maxRetries?: number } = {}) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
  const sleeps: number[] = [];
  const client = createOktaClient(
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      timeoutMs: 50,
      maxRetries: opts.maxRetries ?? 2,
      retryBaseMs: 10,
    },
    {
      fetch: (async (input: string, init: RequestInit) => {
        const url = new URL(input);
        calls.push({
          method: init.method ?? "GET",
          url,
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

async function oktaError(p: Promise<unknown>): Promise<OktaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OktaError) return err;
    throw err;
  }
  throw new Error("expected OktaError");
}

describe("user lookup", () => {
  it("finds an existing user by exact login and employeeNumber, with the SSWS header", async () => {
    const { client, calls } = clientWith(({ url }) =>
      url.pathname.startsWith("/api/v1/users/")
        ? json(200, user(USER, "syn@example.com", "E-1"))
        : json(200, [user(USER, "syn@example.com", "E-1")]),
    );
    const found = await client.findUsersByExactIdentity({
      login: "syn@example.com",
      employeeNumber: "E-1",
    });
    expect(found.map((u) => u.id)).toEqual([USER]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/users/syn%40example.com");
    expect(calls[1]!.url.searchParams.get("search")).toBe('profile.employeeNumber eq "E-1"');
    expect(calls[0]!.headers.Authorization).toBe(`SSWS ${TOKEN}`);
    expect(found[0]).not.toHaveProperty("_links");
  });

  it("returns every distinct candidate so ambiguity can be detected", async () => {
    const { client } = clientWith(({ url }) =>
      url.pathname.startsWith("/api/v1/users/")
        ? json(200, user(USER, "syn@example.com", "E-1"))
        : json(200, [user(OTHER, "old@example.com", "E-1")]),
    );
    const found = await client.findUsersByExactIdentity({
      login: "syn@example.com",
      employeeNumber: "E-1",
    });
    expect(found.map((u) => u.id).sort()).toEqual([USER, OTHER].sort());
  });

  it("returns no candidates when nothing matches", async () => {
    const { client } = clientWith(({ url }) =>
      url.pathname.startsWith("/api/v1/users/")
        ? json(404, { errorCode: "E0000007" })
        : json(200, []),
    );
    expect(
      await client.findUsersByExactIdentity({ login: "none@example.com", employeeNumber: "E-9" }),
    ).toEqual([]);
  });

  it("rejects search values that could break out of the expression, before any request", async () => {
    const { client, calls } = clientWith(() => json(200, []));
    const err = await oktaError(
      client.findUsersByExactIdentity({ login: "a@example.com", employeeNumber: 'x" or 1 eq "1' }),
    );
    expect(err.code).toBe("REQUEST_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("writes", () => {
  it("creates a STAGED user without activation and returns it", async () => {
    const { client, calls } = clientWith(() => json(200, user(USER, "syn@example.com", "E-1")));
    const created = await client.createUser({
      login: "syn@example.com",
      email: "syn@example.com",
      firstName: "Syn",
      lastName: "Thetic",
      employeeNumber: "E-1",
    });
    expect(created.id).toBe(USER);
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual([
      "POST",
      "/api/v1/users",
      "?activate=false",
    ]);
    expect(calls[0]!.body).toEqual({
      profile: {
        login: "syn@example.com",
        email: "syn@example.com",
        firstName: "Syn",
        lastName: "Thetic",
        employeeNumber: "E-1",
      },
    });
  });

  it.each([
    [503, "OUTCOME_UNKNOWN", false],
    [429, "RATE_LIMITED", true],
    [401, "AUTHENTICATION_FAILED", false],
    [400, "BAD_REQUEST", false],
  ] as const)(
    "classifies a create answered %s as %s (notSent=%s) and never retries it",
    async (status, code, notSent) => {
      const { client, calls } = clientWith(() =>
        json(status, { errorCode: "E0000001", errorSummary: `login taken ${TOKEN}` }),
      );
      const err = await oktaError(
        client.createUser({
          login: "a@example.com",
          email: "a@example.com",
          firstName: "A",
          lastName: "B",
          employeeNumber: "E-1",
        }),
      );
      expect([err.code, err.notSent]).toEqual([code, notSent]);
      expect(calls).toHaveLength(1);
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain("login taken");
    },
  );

  it("treats a timed-out write as outcome unknown", async () => {
    const { client } = clientWith(
      ({ init }) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    expect((await oktaError(client.addUserToGroup(GROUP, USER))).code).toBe("OUTCOME_UNKNOWN");
  });

  it("adds a membership with an idempotent PUT", async () => {
    const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
    await client.addUserToGroup(GROUP, USER);
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual([
      "PUT",
      `/api/v1/groups/${GROUP}/users/${USER}`,
    ]);
  });

  it("rejects malformed ids before any request", async () => {
    const { client, calls } = clientWith(() => json(200, {}));
    expect((await oktaError(client.addUserToGroup("00gBAD", USER))).code).toBe("REQUEST_INVALID");
    expect((await oktaError(client.getUser("../admin"))).code).toBe("REQUEST_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("reads, retries and membership", () => {
  it("retries 429 honoring Retry-After, then succeeds", async () => {
    let n = 0;
    const { client, sleeps } = clientWith(() =>
      n++ === 0
        ? json(429, {}, { "retry-after": "3" })
        : json(200, { id: GROUP, type: "OKTA_GROUP", profile: { name: "AOO Eng" } }),
    );
    expect((await client.getGroup(GROUP))?.profile.name).toBe("AOO Eng");
    expect(sleeps).toEqual([3000]);
  });

  it("honors X-Rate-Limit-Reset when there is no Retry-After (capped at 10 s)", async () => {
    let n = 0;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { client, sleeps } = clientWith(() =>
      n++ === 0 ? json(429, {}, { "x-rate-limit-reset": String(reset) }) : json(200, []),
    );
    await client.isUserInGroup(USER, GROUP);
    expect(sleeps).toEqual([10_000]);
  });

  it("retries 5xx reads with bounded attempts", async () => {
    const { client, calls } = clientWith(() => json(503, {}), { maxRetries: 2 });
    expect((await oktaError(client.getUser(USER))).code).toBe("UNAVAILABLE");
    expect(calls).toHaveLength(3);
  });

  it("does not retry authentication failures", async () => {
    const { client, calls } = clientWith(() => json(401, { errorCode: "E0000011" }));
    const err = await oktaError(client.getGroup(GROUP));
    expect([err.code, err.retryable, err.oktaErrorCode]).toEqual([
      "AUTHENTICATION_FAILED",
      false,
      "E0000011",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("returns null for a missing group or user", async () => {
    const { client } = clientWith(() => json(404, { errorCode: "E0000007" }));
    expect(await client.getGroup(GROUP)).toBeNull();
    expect(await client.getUser(USER)).toBeNull();
  });

  it("checks membership across pages (same origin only)", async () => {
    const { client, calls } = clientWith(({ url }) =>
      url.searchParams.get("after")
        ? json(200, [{ id: GROUP }])
        : json(200, [{ id: "00g9zzzzzzzzzzzzzzzz" }], {
            link: `<${BASE}/api/v1/users/${USER}/groups?after=x&limit=200>; rel="next"`,
          }),
    );
    expect(await client.isUserInGroup(USER, GROUP)).toBe(true);
    expect(calls).toHaveLength(2);
    const other = clientWith(() =>
      json(200, [{ id: "00g9zzzzzzzzzzzzzzzz" }], {
        link: `<https://evil.example.com/next>; rel="next"`,
      }),
    );
    expect(await other.client.isUserInGroup(USER, GROUP)).toBe(false);
    expect(other.calls).toHaveLength(1);
  });
});

describe("configuration and redaction", () => {
  it("validates the connection settings without echoing values", () => {
    expect(() =>
      loadOktaConfig({ OKTA_BASE_URL: "http://dev.okta.com", OKTA_API_TOKEN: TOKEN }),
    ).toThrow(/OKTA_BASE_URL/);
    try {
      loadOktaConfig({ OKTA_BASE_URL: `https://dev.okta.com/path`, OKTA_API_TOKEN: "short" });
    } catch (err) {
      expect((err as Error).message).not.toContain("short");
      expect((err as Error).message).toMatch(/OKTA_API_TOKEN/);
    }
    expect(loadOktaConfig({ OKTA_BASE_URL: `${BASE}/`, OKTA_API_TOKEN: TOKEN }).baseUrl).toBe(BASE);
  });

  it("maps only explicitly configured group targets and rejects malformed ids", () => {
    const targets = loadOktaGroupTargets({
      OKTA_ENGINEERING_GROUP_ID: GROUP,
      OKTA_ENGINEERING_GROUP_NAME: "AOO Eng",
    });
    expect(targets.get("okta-engineering-group")).toEqual({
      resourceId: "okta-engineering-group",
      groupId: GROUP,
      expectedName: "AOO Eng",
    });
    expect(targets.has("jira-engineering")).toBe(false);
    expect(() => loadOktaGroupTargets({ OKTA_ENGINEERING_GROUP_ID: "Engineering" })).toThrow(
      /OKTA_ENGINEERING_GROUP_ID/,
    );
  });

  it("redacts SSWS tokens, authorization values, URL queries and given values", () => {
    const out = redactOktaText(
      `Authorization: SSWS ${TOKEN} bearer abc.def.ghi https://x.okta.com/api/v1/users?search=profile.email token=zzz EMP-M7A-777`,
      ["EMP-M7A-777"],
    );
    expect(out).not.toMatch(new RegExp(`${TOKEN}|abc\\.def|search=|zzz|EMP-M7A-777`));
  });
});
