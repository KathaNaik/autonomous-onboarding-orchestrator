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
const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionValue,
  isValidAdminToken,
  verifySessionValue,
} = await import("@/lib/operator-session");
const { POST: login } = await import("@/app/admin/onboarding/session/route");
const { POST: logout } = await import("@/app/admin/onboarding/logout/route");
const { default: ListPage } = await import("@/app/admin/onboarding/page");
const { default: DetailPage } = await import("@/app/admin/onboarding/[workflowId]/page");
const { default: LoginPage } = await import("@/app/admin/onboarding/login/page");

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

  it("checks the submitted token in constant time and refuses odd input", () => {
    expect(isValidAdminToken(ADMIN_TOKEN, ADMIN_TOKEN)).toBe(true);
    for (const bad of ["", "wrong", `${ADMIN_TOKEN} `, null, 42, "x".repeat(1000)])
      expect(isValidAdminToken(bad, ADMIN_TOKEN)).toBe(false);
  });
});

describe("login and logout (server-side handlers)", () => {
  it("valid login sets only an HttpOnly, SameSite=Strict, path-restricted, short-lived session and redirects", async () => {
    const res = await login(form({ token: ADMIN_TOKEN, operatorId: "ops.alice" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/onboarding");
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
    const everything = JSON.stringify([...res.headers.entries()]) + (await res.text());
    expect(everything).not.toContain(ADMIN_TOKEN);
    const secure = await login(
      form({ token: ADMIN_TOKEN, operatorId: "ops.alice" }, { "x-forwarded-proto": "https" }),
    );
    expect(secure.headers.get("set-cookie")).toContain("Secure");
  });

  it.each([
    [
      "a wrong token",
      { token: "wrong-token-000000000000000000000000000", operatorId: "ops.alice" },
    ],
    ["a missing token", { operatorId: "ops.alice" }],
    ["an invalid operator id", { token: ADMIN_TOKEN, operatorId: "not valid!" }],
  ])("%s → generic unauthorized, no cookie", async (_, fields) => {
    const res = await login(form(fields as Record<string, string>));
    expect([res.status, res.headers.get("location")]).toEqual([
      303,
      "/admin/onboarding/login?error=unauthorized",
    ]);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts same-site posts behind a proxy/container (Origin vs Host), refuses cross-site ones", async () => {
    // Inside a container request.url carries an internal host; the browser's Origin matches Host.
    const proxied = await login(
      form(
        { token: ADMIN_TOKEN, operatorId: "ops.a" },
        { origin: "http://localhost:3000", host: "localhost:3000" },
        "http://0.0.0.0:3000/admin/onboarding/session",
      ),
    );
    expect(proxied.status).toBe(303);
    expect(proxied.headers.get("set-cookie")).toContain("HttpOnly");
    const spoof = await login(
      form(
        { token: ADMIN_TOKEN, operatorId: "ops.a" },
        { origin: "https://evil.example", host: "localhost:3000" },
        "http://0.0.0.0:3000/admin/onboarding/session",
      ),
    );
    expect(spoof.status).toBe(403);
  });

  it("refuses cross-site login and logout posts", async () => {
    expect(
      (
        await login(
          form({ token: ADMIN_TOKEN, operatorId: "ops.a" }, { origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await logout(
          form({}, { origin: "https://evil.example" }, "http://web/admin/onboarding/logout"),
        )
      ).status,
    ).toBe(403);
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

  it("the login page is a plain server form posting to the handler (no client script, no token value)", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ error: "unauthorized" }) }),
    );
    const formTag = html.match(/<form[^>]*>/)![0];
    expect(formTag).toContain('action="/admin/onboarding/session"');
    expect(formTag).toContain('method="post"');
    expect(html).not.toContain("<script");
    expect(html).toContain('type="password"');
    expect(html).toContain("Unauthorized.");
    expect(html).not.toContain(ADMIN_TOKEN);
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
    jar.set(SESSION_COOKIE, createSessionValue("ops.alice", ADMIN_TOKEN));
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
    const dashboard = sources.filter(
      ({ file }) =>
        file.includes(join("app", "admin", "onboarding")) &&
        !file.includes(`${join("[workflowId]", "github")}`),
    );
    expect(dashboard.length).toBeGreaterThan(5);
    for (const { file, src } of dashboard) {
      expect(src, file).not.toMatch(/^\s*["']use client["']/m); // the dashboard ships no client components
      expect(src, file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|document\.cookie|useState/,
      );
    }
  });

  it("the old browser-side dashboard proxies are gone (only the M7B HR proxy remains)", () => {
    const apiRoutes = sources.filter(({ file }) => file.includes(join("app", "api", "admin")));
    expect(apiRoutes.map(({ file }) => file.slice(file.indexOf(join("app", "api"))))).toEqual([
      join("app", "api", "admin", "onboarding", "[workflowId]", "github-identity", "route.ts"),
    ]);
  });
});
