import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server request context: a controllable cookie jar.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));

const ADMIN_TOKEN = "server-only-admin-token-0123456789-abcdefXYZ";
const { SESSION_COOKIE, createSessionValue, verifySessionValue } =
  await import("@/lib/operator-session");
const { POST: complete } =
  await import("@/app/admin/onboarding/[workflowId]/resources/[accessRequestId]/complete/route");

const WF = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const AR = "2f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c";
const ctx = (accessRequestId = AR) => ({
  params: Promise.resolve({ workflowId: WF, accessRequestId }),
});
const form = (fields: Record<string, string>, origin = "http://web") =>
  new Request(`http://web/admin/onboarding/${WF}/resources/${AR}/complete`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin, host: "web" },
  });
const ok = {
  accessRequestId: AR,
  workflowId: WF,
  resourceId: "cursor-license",
  status: "PROVISIONED",
  changed: true,
  completedBy: "hr.alice",
  provisionedAt: "2026-10-12T10:00:00.000Z",
};

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

describe("workflow page: Mark as done (MANUAL tools)", () => {
  it("forwards only the evidence with the server token and the session operator", async () => {
    const fetchMock = vi.fn(async () => Response.json(ok));
    vi.stubGlobal("fetch", fetchMock);
    const res = await complete(
      form({ evidence: "License assigned in the admin console", operatorId: "forged" }),
      ctx(),
    );
    expect([res.status, res.headers.get("location")]).toEqual([
      303,
      `/admin/onboarding/${WF}?result=done`,
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      `http://api.internal:4000/admin/access-requests/${AR}/manual-complete`,
    );
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "hr.alice", // from the signed session, never from the form
      "x-operator-session": verifySessionValue(cookie, ADMIN_TOKEN)!.nonce,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      evidence: "License assigned in the admin console",
    });
  });

  it("an identical repeat is 'unchanged'; API errors map to fixed codes, never echoed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...ok, changed: false })),
    );
    expect(
      (await complete(form({ evidence: "Assigned in console" }), ctx())).headers.get("location"),
    ).toBe(`/admin/onboarding/${WF}?result=unchanged`);
    for (const [error, code] of [
      ["INVALID_EVIDENCE", "INVALID_EVIDENCE"],
      ["MANUAL_ALREADY_COMPLETED", "MANUAL_ALREADY_COMPLETED"],
      ["<script>x</script>", "INTERNAL_ERROR"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error, message: "<b>raw</b>" }, { status: 409 })),
      );
      const res = await complete(form({ evidence: "Assigned in console" }), ctx());
      expect(res.headers.get("location")).toBe(`/admin/onboarding/${WF}?result=${code}`);
    }
  });

  it("refuses cross-site posts, missing sessions and malformed ids without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await complete(form({ evidence: "x".repeat(10) }, "https://evil.test"), ctx())).status,
    ).toBe(403);
    const bad = await complete(form({ evidence: "x".repeat(10) }), ctx("not-a-uuid"));
    expect(bad.headers.get("location")).toBe(
      `/admin/onboarding/${WF}?result=ACCESS_REQUEST_NOT_FOUND`,
    );
    jar.clear();
    const res = await complete(form({ evidence: "x".repeat(10) }), ctx());
    expect(res.headers.get("location")).toBe("/admin/onboarding/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a logged-out (revoked) session goes back to login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "OPERATOR_UNAUTHORIZED", message: "no" }, { status: 401 }),
      ),
    );
    const res = await complete(form({ evidence: "Assigned in console" }), ctx());
    expect(res.headers.get("location")).toBe("/admin/onboarding/login?error=expired");
  });
});
