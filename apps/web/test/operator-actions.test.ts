import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));

const ADMIN_TOKEN = "server-only-admin-token-0123456789-abcdefXYZ";
const { SESSION_COOKIE, createSessionValue, verifySessionValue } =
  await import("@/lib/operator-session");
const { POST: retry } =
  await import("@/app/admin/onboarding/[workflowId]/resources/[accessRequestId]/retry/route");
const { POST: requestApproval } =
  await import("@/app/admin/onboarding/[workflowId]/resources/[accessRequestId]/request-approval/route");
const { MANUAL_RESULT_MESSAGES } = await import("@/lib/console-model");

const WF = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const AR = "2f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c";
const ctx = (accessRequestId = AR) => ({
  params: Promise.resolve({ workflowId: WF, accessRequestId }),
});
const form = (origin = "http://web") =>
  new Request(`http://web/admin/onboarding/${WF}/resources/${AR}/retry`, {
    method: "POST",
    body: new URLSearchParams({ operatorId: "forged" }),
    headers: { origin, host: "web" },
  });

let cookie = "";
beforeEach(() => {
  vi.stubEnv("ONBOARDING_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("API_BASE_URL", "http://api.internal:4000");
  jar.clear();
  cookie = createSessionValue("hr.alice", ADMIN_TOKEN);
  jar.set(SESSION_COOKIE, cookie);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("workflow page: Retry and Request approval again", () => {
  it("retry calls the API with the server token and the session operator, no body", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        accessRequestId: AR,
        workflowId: WF,
        resourceId: "slack-engineering",
        status: "READY_FOR_PROVISIONING",
        retryGeneration: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await retry(form(), ctx());
    expect([res.status, res.headers.get("location")]).toEqual([
      303,
      `/admin/onboarding/${WF}?result=retried`,
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://api.internal:4000/admin/access-requests/${AR}/retry`);
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "hr.alice",
      "x-operator-session": verifySessionValue(cookie, ADMIN_TOKEN)!.nonce,
    });
    expect(init.body).toBeUndefined();
  });

  it("request approval again → approval_requested; errors map to fixed codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { accessRequestId: AR, approvalId: WF, status: "REQUESTED", changed: true },
          { status: 202 },
        ),
      ),
    );
    expect((await requestApproval(form(), ctx())).headers.get("location")).toBe(
      `/admin/onboarding/${WF}?result=approval_requested`,
    );
    for (const [error, code] of [
      ["NOT_AWAITING_APPROVAL", "NOT_AWAITING_APPROVAL"],
      ["NOT_FAILED", "NOT_FAILED"],
      ["<script>", "INTERNAL_ERROR"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error, message: "raw" }, { status: 409 })),
      );
      expect((await retry(form(), ctx())).headers.get("location")).toBe(
        `/admin/onboarding/${WF}?result=${code}`,
      );
    }
    for (const code of ["retried", "approval_requested", "NOT_FAILED", "NOT_AWAITING_APPROVAL"]) {
      expect(MANUAL_RESULT_MESSAGES[code]).toBeDefined();
    }
  });

  it("refuses cross-site posts and missing sessions without calling the API; 401 → login", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await retry(form("https://evil.test"), ctx())).status).toBe(403);
    jar.clear();
    expect((await retry(form(), ctx())).headers.get("location")).toBe("/admin/onboarding/login");
    expect(fetchMock).not.toHaveBeenCalled();
    jar.set(SESSION_COOKIE, cookie);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "OPERATOR_UNAUTHORIZED", message: "no" }, { status: 401 }),
      ),
    );
    expect((await requestApproval(form(), ctx())).headers.get("location")).toBe(
      "/admin/onboarding/login?error=expired",
    );
  });
});
