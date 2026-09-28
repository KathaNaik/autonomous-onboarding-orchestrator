import type { GitHubIdentityStatus } from "@aoo/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusLines } from "@/app/admin/onboarding/[workflowId]/github/github-account-form";
import GitHubAccountPage from "@/app/admin/onboarding/[workflowId]/github/page";
import { GET, POST } from "@/app/api/admin/onboarding/[workflowId]/github-identity/route";

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

afterEach(() => vi.unstubAllGlobals());

describe("HR GitHub account proxy", () => {
  it("forwards the operator's credentials, operator id and only the username", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...status, changed: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(
      new Request("http://web/api", {
        method: "POST",
        headers: { authorization: "Bearer op-token", "x-operator-id": "hr.alice" },
        body: JSON.stringify({ githubLogin: "octocat", source: "EMPLOYEE_INPUT" }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://localhost:4000/admin/onboarding/${WF}/github-identity`);
    expect(init.headers).toMatchObject({
      authorization: "Bearer op-token",
      "x-operator-id": "hr.alice",
    });
    expect(JSON.parse(init.body as string)).toEqual({ githubLogin: "octocat" });
  });

  it("passes API errors through and never calls the API for a malformed workflow id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "OPERATOR_UNAUTHORIZED", message: "no" }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://web/api"), ctx);
    expect([res.status, (await res.json()).error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
    const bad = await GET(new Request("http://web/api"), {
      params: Promise.resolve({ workflowId: "../x" }),
    });
    expect(bad.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HR GitHub account page", () => {
  it("is an operator page with no employee-facing connect form", async () => {
    const html = renderToStaticMarkup(await GitHubAccountPage(ctx));
    expect(html).toContain("GitHub Account");
    expect(html).toContain("For HR and onboarding staff");
    expect(html).toContain("Operator token");
    expect(html).not.toContain("Connect GitHub");
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
