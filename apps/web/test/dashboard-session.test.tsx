import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WF, base } from "./dashboard-fixture";

// Server-component request context: a controllable cookie jar and Next's redirect signal.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const ADMIN_TOKEN = "server-only-admin-token-0123456789-abcdefXYZ";
const { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionValue, verifySessionValue } =
  await import("@/lib/operator-session");
const { POST: login } = await import("@/app/admin/onboarding/session/route");
const { POST: logout } = await import("@/app/admin/onboarding/logout/route");
const { default: ListPage } = await import("@/app/admin/onboarding/page");
const { default: DetailPage } = await import("@/app/admin/onboarding/[workflowId]/page");
const { default: LoginPage } = await import("@/app/admin/onboarding/login/page");
const { default: SignUpPage } = await import("@/app/admin/onboarding/signup/page");
const { POST: signUp } = await import("@/app/admin/onboarding/signup/create/route");

beforeEach(() => {
  vi.stubEnv("ONBOARDING_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("API_BASE_URL", "http://api.internal:4000");
  jar.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const form = (
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  url = "http://web/admin/onboarding/session",
) =>
  new Request(url, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin: new URL(url).origin, ...headers },
  });
const redirectOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: { digest?: string }) => e,
  );
  return err?.digest?.split(";")[1] ?? null;
};
const now = () => Math.floor(Date.now() / 1000);

describe("session tokens (signed, short-lived, no admin token inside)", () => {
  it("round-trips and carries only operator id, times and a nonce", () => {
    const value = createSessionValue("ops.alice", ADMIN_TOKEN);
    expect(verifySessionValue(value, ADMIN_TOKEN)).toMatchObject({ operatorId: "ops.alice" });
    const payload = JSON.parse(Buffer.from(value.split(".")[0]!, "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "n", "op", "v"]);
    expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
    for (const form of [
      ADMIN_TOKEN,
      Buffer.from(ADMIN_TOKEN).toString("base64"),
      Buffer.from(ADMIN_TOKEN).toString("base64url"),
    ]) {
      expect(value).not.toContain(form);
    }
  });

  it("rejects tampered, forged, expired, future and re-keyed sessions", () => {
    const value = createSessionValue("ops.alice", ADMIN_TOKEN);
    const [body, mac] = value.split(".") as [string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        op: "ops.mallory",
      }),
    ).toString("base64url");
    for (const bad of [
      `${forgedBody}.${mac}`,
      `${body}.${mac.slice(0, -2)}AA`,
      `${body}.`,
      body,
      `${body}.${mac}.extra`,
      "",
      "x".repeat(600),
    ]) {
      expect(verifySessionValue(bad, ADMIN_TOKEN)).toBeNull();
    }
    expect(verifySessionValue(value, ADMIN_TOKEN, now() + SESSION_TTL_SECONDS + 1)).toBeNull(); // expired
    expect(
      verifySessionValue(createSessionValue("ops.a", ADMIN_TOKEN, now() + 3600), ADMIN_TOKEN),
    ).toBeNull(); // future
    expect(verifySessionValue(value, "a-rotated-admin-token-0123456789abcdefgh")).toBeNull(); // rotation
  });
});

const PASSWORD = "correct horse battery staple";
const EMAIL = "ops.alice@example.com";
/** The API's operator-account routes, as seen from the web server. */
const accountApi = (status = 200, body: unknown = { operatorId: EMAIL }) => {
  const mock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
};
const sentTo = (mock: ReturnType<typeof accountApi>, i = 0) => {
  const [url, init] = mock.mock.calls[i] as unknown as [URL, RequestInit];
  return { url: String(url), init, body: JSON.parse(init.body as string) };
};

describe("(M12) sign-in with an operator account (server-side handlers)", () => {
  it("valid sign-in: the API checks the password; the browser gets only an HttpOnly, SameSite=Strict, path-restricted, short-lived session", async () => {
    const api = accountApi();
    const res = await login(form({ email: ` ${EMAIL} `, password: PASSWORD, extra: "x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/onboarding");
    const call = sentTo(api);
    expect(call.url).toBe("http://api.internal:4000/admin/operator-accounts/sign-in");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(call.body).toEqual({ email: EMAIL, password: PASSWORD });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`));
    for (const attr of [
      "HttpOnly",
      "SameSite=Strict",
      "Path=/admin/onboarding",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ]) {
      expect(cookie).toContain(attr);
    }
    expect(cookie).not.toContain("Secure"); // plain http
    const value = cookie.split(";")[0]!.split("=")[1]!;
    expect(verifySessionValue(value, ADMIN_TOKEN)?.operatorId).toBe(EMAIL);
    const everything = JSON.stringify([...res.headers.entries()]) + (await res.text());
    expect(everything).not.toContain(ADMIN_TOKEN);
    expect(everything).not.toContain(PASSWORD);
    const secure = await login(
      form({ email: EMAIL, password: PASSWORD }, { "x-forwarded-proto": "https" }),
    );
    expect(secure.headers.get("set-cookie")).toContain("Secure");
  });

  it.each([
    ["AOO_ENVIRONMENT", "production"],
    ["VERCEL_ENV", "production"],
  ])("(M10) %s=%s forces Secure cookies even for a plain-http request", async (name, value) => {
    vi.stubEnv(name, value);
    accountApi();
    const res = await login(form({ email: EMAIL, password: PASSWORD }));
    expect(res.headers.get("set-cookie")).toContain("Secure");
    const out = await logout(
      new Request("http://web/admin/onboarding/logout", {
        method: "POST",
        headers: { origin: "http://web" },
      }),
    );
    expect(out.headers.get("set-cookie")).toContain("Secure");
  });

  it("wrong credentials (API 401) → generic unauthorized, no cookie", async () => {
    accountApi(401, { error: "INVALID_CREDENTIALS", message: "x" });
    const res = await login(form({ email: EMAIL, password: "wrong password 123" }));
    expect([res.status, res.headers.get("location")]).toEqual([
      303,
      "/admin/onboarding/login?error=unauthorized",
    ]);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the old shared-token form (token + operator id) is not a sign-in: no API call, no cookie", async () => {
    const api = accountApi();
    const res = await login(form({ token: ADMIN_TOKEN, operatorId: "ops.alice" }));
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?error=unauthorized");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("an unreachable API → 'unavailable', no cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const res = await login(form({ email: EMAIL, password: PASSWORD }));
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?error=unavailable");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts same-site posts behind a proxy/container (Origin vs Host), refuses cross-site ones", async () => {
    accountApi();
    // Inside a container request.url carries an internal host; the browser's Origin matches Host.
    const proxied = await login(
      form(
        { email: EMAIL, password: PASSWORD },
        { origin: "http://localhost:3000", host: "localhost:3000" },
        "http://0.0.0.0:3000/admin/onboarding/session",
      ),
    );
    expect(proxied.status).toBe(303);
    expect(proxied.headers.get("set-cookie")).toContain("HttpOnly");
    const spoof = await login(
      form(
        { email: EMAIL, password: PASSWORD },
        { origin: "https://evil.example", host: "localhost:3000" },
        "http://0.0.0.0:3000/admin/onboarding/session",
      ),
    );
    expect(spoof.status).toBe(403);
  });

  it("refuses cross-site sign-in, sign-up and logout posts", async () => {
    const api = accountApi();
    const evil = { origin: "https://evil.example" };
    expect((await login(form({ email: EMAIL, password: PASSWORD }, evil))).status).toBe(403);
    expect(
      (
        await signUp(
          form(
            { email: EMAIL, password: PASSWORD, confirm: PASSWORD },
            evil,
            "http://web/admin/onboarding/signup/create",
          ),
        )
      ).status,
    ).toBe(403);
    expect((await logout(form({}, evil, "http://web/admin/onboarding/logout"))).status).toBe(403);
    expect(api).not.toHaveBeenCalled();
  });

  it("logout clears the session cookie", async () => {
    const res = await logout(form({}, {}, "http://web/admin/onboarding/logout"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?loggedOut=1");
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=; Path=/admin/onboarding; Max-Age=0; HttpOnly; SameSite=Strict`,
      ),
    );
  });

  it("the sign-in page is a plain server form: email + password, a sign-up link, no token field", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ error: "unauthorized" }) }),
    );
    const formTag = html.match(/<form[^>]*>/)![0];
    expect(formTag).toContain('action="/admin/onboarding/session"');
    expect(formTag).toContain('method="post"');
    expect(html).not.toContain("<script");
    expect(html).toContain('name="email"');
    expect(html).toMatch(/name="password"[^>]*type="password"|type="password"[^>]*name="password"/);
    expect(html).not.toMatch(/Operator token|name="token"/);
    expect(html).toContain('href="/admin/onboarding/signup"');
    expect(html).toContain("Sign-in failed.");
    expect(html).not.toContain(ADMIN_TOKEN);
  });
});

describe("(M12) create an operator account", () => {
  const signUpForm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    form(fields, headers, "http://web/admin/onboarding/signup/create");

  it("creates the account at the API and signs the operator in", async () => {
    const api = accountApi(201);
    const res = await signUp(signUpForm({ email: EMAIL, password: PASSWORD, confirm: PASSWORD }));
    expect(res.headers.get("location")).toBe("/admin/onboarding");
    expect(sentTo(api).url).toBe("http://api.internal:4000/admin/operator-accounts");
    expect(sentTo(api).body).toEqual({ email: EMAIL, password: PASSWORD });
    const value = res.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    expect(verifySessionValue(value, ADMIN_TOKEN)?.operatorId).toBe(EMAIL);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(PASSWORD);
  });

  it("mismatched passwords never reach the API", async () => {
    const api = accountApi(201);
    const res = await signUp(
      signUpForm({ email: EMAIL, password: PASSWORD, confirm: `${PASSWORD}!` }),
    );
    expect(res.headers.get("location")).toBe("/admin/onboarding/signup?error=PASSWORD_MISMATCH");
    expect(api).not.toHaveBeenCalled();
  });

  it.each([
    [400, "INVALID_PAYLOAD", "INVALID_PAYLOAD"],
    [409, "ACCOUNT_UNAVAILABLE", "ACCOUNT_UNAVAILABLE"],
    [429, "SIGNUP_LIMIT_REACHED", "SIGNUP_LIMIT_REACHED"],
    [500, "INTERNAL_ERROR", "unavailable"],
  ])("API %s %s → page error %s, no cookie", async (status, error, shown) => {
    accountApi(status, { error, message: "x" });
    const res = await signUp(signUpForm({ email: EMAIL, password: PASSWORD, confirm: PASSWORD }));
    expect(res.headers.get("location")).toBe(`/admin/onboarding/signup?error=${shown}`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the sign-up page is a plain server form with a confirmation field", async () => {
    const html = renderToStaticMarkup(
      await SignUpPage({ searchParams: Promise.resolve({ error: "SIGNUP_LIMIT_REACHED" }) }),
    );
    expect(html).toContain('action="/admin/onboarding/signup/create"');
    for (const n of ['name="email"', 'name="password"', 'name="confirm"'])
      expect(html).toContain(n);
    expect(html).not.toContain("<script");
    expect(html).toContain("No more accounts can be created today.");
  });
});

describe("server-rendered dashboard (server-side proxy only)", () => {
  const apiFetch = () => {
    const fn = vi.fn(async (url: URL) =>
      String(url).includes(`/admin/onboarding/${WF}`)
        ? Response.json(base)
        : Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("without a session (missing, tampered or expired) every page redirects to login; the API is never called", async () => {
    const fetchMock = apiFetch();
    const expired = createSessionValue("ops.a", ADMIN_TOKEN, now() - SESSION_TTL_SECONDS - 5);
    for (const value of [undefined, "tampered.value", expired]) {
      jar.clear();
      if (value) jar.set(SESSION_COOKIE, value);
      expect(await redirectOf(ListPage({ searchParams: Promise.resolve({}) }))).toBe(
        "/admin/onboarding/login",
      );
      expect(await redirectOf(DetailPage({ params: Promise.resolve({ workflowId: WF }) }))).toBe(
        "/admin/onboarding/login",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a valid session reads through the server: the API gets the server-only token and the session's operator id", async () => {
    const fetchMock = apiFetch();
    const cookie = createSessionValue("ops.alice", ADMIN_TOKEN);
    jar.set(SESSION_COOKIE, cookie);
    const html = renderToStaticMarkup(
      await DetailPage({ params: Promise.resolve({ workflowId: WF }) }),
    );
    expect(html).toContain("1. Overview");
    expect(html).toContain("non-employee-production-deny");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://api.internal:4000/admin/onboarding/${WF}`);
    expect(init.headers).toEqual({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "ops.alice",
      // (M10) the session nonce, which the API refuses after logout
      "x-operator-session": verifySessionValue(cookie, ADMIN_TOKEN)!.nonce,
    });
    expect(html).not.toContain(ADMIN_TOKEN); // never serialized into the page
    const list = renderToStaticMarkup(
      await ListPage({ searchParams: Promise.resolve({ state: "COMPLETED", evil: "1" }) }),
    );
    expect(list).toContain("No workflows found.");
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "http://api.internal:4000/admin/onboarding?limit=25&state=COMPLETED",
    );
    expect(list).not.toContain(ADMIN_TOKEN);
  });

  it("an operator can't impersonate another by editing the cookie; a workflow-id lookup redirects", async () => {
    apiFetch();
    const value = createSessionValue("ops.alice", ADMIN_TOKEN);
    const [body, mac] = value.split(".") as [string, string];
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), op: "ops.root" }),
    ).toString("base64url");
    jar.set(SESSION_COOKIE, `${edited}.${mac}`);
    expect(await redirectOf(ListPage({ searchParams: Promise.resolve({}) }))).toBe(
      "/admin/onboarding/login",
    );
    jar.set(SESSION_COOKIE, value);
    expect(
      await redirectOf(
        ListPage({ searchParams: Promise.resolve({ workflowId: WF.toUpperCase() }) }),
      ),
    ).toBe(`/admin/onboarding/${WF}`);
  });
});

describe("browser secret boundary (source scan)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const sources = [...walk(join(root, "app")), ...walk(join(root, "lib"))].map((file) => ({
    file,
    src: readFileSync(file, "utf8"),
  }));

  it("the admin token is read only by server code (lib/config.ts), never by a client component", () => {
    for (const { file, src } of sources) {
      expect(src, file).not.toMatch(/NEXT_PUBLIC_/);
      if (!file.endsWith(join("lib", "config.ts"))) expect(src, file).not.toMatch(/process\.env/);
      if (/^\s*["']use client["']/m.test(src)) {
        expect(src, file).not.toMatch(
          /ONBOARDING_ADMIN_TOKEN|loadWebConfig|operator-session|dashboard-auth|onboarding-read-api/,
        );
      }
    }
    // (M10) The M7B GitHub-identity page is part of the session-protected dashboard now.
    const dashboard = sources.filter(({ file }) =>
      file.includes(join("app", "admin", "onboarding")),
    );
    expect(dashboard.length).toBeGreaterThan(5);
    for (const { file, src } of dashboard) {
      expect(src, file).not.toMatch(/^\s*["']use client["']/m); // the dashboard ships no client components
      expect(src, file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|document\.cookie|useState/,
      );
    }
  });

  it("no browser-side admin proxy remains (M10: the M7B HR proxy was removed too)", () => {
    expect(sources.filter(({ file }) => file.includes(join("app", "api", "admin")))).toEqual([]);
    for (const { file, src } of sources) {
      expect(src, file).not.toMatch(/authorization["']?\s*:\s*request\.headers/i);
      expect(src, file).not.toMatch(/Operator token[\s\S]*type="password"[\s\S]*github/i);
    }
  });
});

describe("(M10) server-side logout revocation", () => {
  it("logout revokes the session's nonce at the API (server token, operator id), then clears the cookie", async () => {
    const cookie = createSessionValue("ops.alice", ADMIN_TOKEN);
    jar.set(SESSION_COOKIE, cookie);
    const fetchMock = vi.fn(async () => Response.json({ revoked: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await logout(form({}, {}, "http://web/admin/onboarding/logout"));
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?loggedOut=1");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://api.internal:4000/admin/operator-sessions/revoke");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "ops.alice",
    });
    const session = verifySessionValue(cookie, ADMIN_TOKEN)!;
    expect(JSON.parse(init.body as string)).toEqual({
      sessionNonce: session.nonce,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    });
  });

  it("an unconfirmed revocation still clears the cookie and says so", async () => {
    jar.set(SESSION_COOKIE, createSessionValue("ops.alice", ADMIN_TOKEN));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const res = await logout(form({}, {}, "http://web/admin/onboarding/logout"));
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?loggedOut=unconfirmed");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a revoked session (API 401) is sent back to login, never shown a partial page", async () => {
    jar.set(SESSION_COOKIE, createSessionValue("ops.alice", ADMIN_TOKEN));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "OPERATOR_UNAUTHORIZED", message: "no" }, { status: 401 }),
      ),
    );
    expect(await redirectOf(DetailPage({ params: Promise.resolve({ workflowId: WF }) }))).toBe(
      "/admin/onboarding/login?error=expired",
    );
    expect(await redirectOf(ListPage({ searchParams: Promise.resolve({}) }))).toBe(
      "/admin/onboarding/login?error=expired",
    );
  });
});
