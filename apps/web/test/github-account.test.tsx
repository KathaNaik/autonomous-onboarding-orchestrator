import type { GitHubIdentityStatus } from "@aoo/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server request context: a controllable cookie jar and Next's redirect signal.
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
const { SESSION_COOKIE, createSessionValue, verifySessionValue } =
  await import("@/lib/operator-session");
const { statusLines } = await import("@/lib/github-identity-status");
const { default: GitHubAccountPage } =
  await import("@/app/admin/onboarding/[workflowId]/github/page");
const { POST: save } = await import("@/app/admin/onboarding/[workflowId]/github/save/route");

const WF = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const status: GitHubIdentityStatus = {
  workflowId: WF,
  employee: { firstName: "Grace", lastName: "Hopper", workEmail: "grace@example.com" },
  identityRequired: true,
  identity: { state: "NOT_SUBMITTED", claimedLogin: null, resolvedLogin: null },
  resources: [
    {
      resourceId: "github-org-membership",
      displayName: "GitHub org",
      progress: "WAITING_FOR_IDENTITY",
    },
  ],
};
const ctx = { params: Promise.resolve({ workflowId: WF }) };
const pageUrl = `http://web/admin/onboarding/${WF}/github/save`;
const form = (fields: Record<string, string>, origin = "http://web") =>
  new Request(pageUrl, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin, host: "web" },
  });
const redirectOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: { digest?: string }) => e,
  );
  return err?.digest?.split(";")[1] ?? null;
};

beforeEach(() => {
  vi.stubEnv("ONBOARDING_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("API_BASE_URL", "http://api.internal:4000");
  jar.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
let cookie = "";
const signIn = () => {
  cookie = createSessionValue("hr.alice", ADMIN_TOKEN);
  jar.set(SESSION_COOKIE, cookie);
};

describe("(M10) HR GitHub account page behind the operator session", () => {
  it("without a session: redirects to login and never calls the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await redirectOf(GitHubAccountPage(ctx))).toBe("/admin/onboarding/login");
    const res = await save(form({ githubLogin: "octocat" }), ctx);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/admin/onboarding/login"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders server-side with the server token; no token field and no token in the HTML", async () => {
    signIn();
    const fetchMock = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(await GitHubAccountPage(ctx));
    expect(html).toContain("GitHub Account");
    expect(html).toContain("For HR and onboarding staff");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain(`action="/admin/onboarding/${WF}/github/save"`);
    expect(html).not.toContain("Operator token");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(ADMIN_TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://api.internal:4000/admin/onboarding/${WF}/github-identity`);
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "hr.alice",
    });
  });

  it("save: forwards only the username with the server token and the session operator", async () => {
    signIn();
    const fetchMock = vi.fn(async () => Response.json({ ...status, changed: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await save(
      form({ githubLogin: "octocat", operatorId: "forged", token: "browser-supplied" }),
      ctx,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/onboarding/${WF}/github?result=saved`);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "hr.alice", // from the signed session, never from the form
      "x-operator-session": verifySessionValue(cookie, ADMIN_TOKEN)!.nonce,
    });
    expect(JSON.parse(init.body as string)).toEqual({ githubLogin: "octocat" });
  });

  it("save: refuses cross-site posts and maps API errors to fixed outcome codes", async () => {
    signIn();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: "GITHUB_IDENTITY_ALREADY_LINKED", message: "<script>x</script>" },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await save(form({ githubLogin: "x" }, "https://evil.test"), ctx)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const res = await save(form({ githubLogin: "other" }), ctx);
    expect(res.headers.get("location")).toBe(
      `/admin/onboarding/${WF}/github?result=GITHUB_IDENTITY_ALREADY_LINKED`,
    );
  });

  it("maps status to HR wording", () => {
    expect(statusLines(status)).toEqual(["Not provided"]);
    expect(
      statusLines({
        ...status,
        identity: { state: "RESOLVED", claimedLogin: "octocat", resolvedLogin: "OctoCat" },
        resources: [
          { resourceId: "a", displayName: "GitHub org", progress: "INVITATION_PENDING" },
          { resourceId: "b", displayName: "Backend team", progress: "CONNECTED" },
        ],
      }),
    ).toEqual([
      "Account resolved: OctoCat",
      "GitHub org: Organization invitation pending",
      "Backend team: GitHub access provisioned",
    ]);
  });
});
