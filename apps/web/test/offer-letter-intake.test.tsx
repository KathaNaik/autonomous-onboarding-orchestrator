import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { default: NewPage } = await import("@/app/admin/onboarding/new/page");
const { POST: upload } = await import("@/app/admin/onboarding/new/upload/route");
const { default: ReviewPage } = await import("@/app/admin/onboarding/new/[extractionId]/page");
const { POST: start } = await import("@/app/admin/onboarding/new/[extractionId]/start/route");

const ID = "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11";
const WF = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const view = (status = "EXTRACTED", workflowId: string | null = null) => ({
  extractionId: ID,
  status,
  uploadedBy: "hr.alice",
  createdAt: "2026-10-06T16:00:00.000Z",
  workflowId,
  proposal: {
    isOfferLetter: true,
    firstName: "Ada",
    lastName: "Example",
    workEmail: "ada@example.com",
    jobTitle: "Backend Software Engineer",
    department: "Engineering",
    managerName: "Sam Lead",
    startDate: "2026-11-02",
    jobSummary: "Builds backend services.",
    warnings: ["SENSITIVE_CONTENT_REMOVED:jobSummary"],
  },
});
// A tiny stand-in PDF: the web layer only checks the signature and forwards the exact bytes.
const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n% synthetic offer letter\n%%EOF\n", "latin1"));
let cookie = "";
const signIn = () => {
  cookie = createSessionValue("hr.alice", ADMIN_TOKEN);
  jar.set(SESSION_COOKIE, cookie);
};
const redirectOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: { digest?: string }) => e,
  );
  return err?.digest?.split(";")[1] ?? null;
};
const multipart = (file: File | null, origin = "http://web") => {
  const fd = new FormData();
  if (file) fd.set("offerLetter", file);
  return new Request("http://web/admin/onboarding/new/upload", {
    method: "POST",
    body: fd,
    headers: { origin, host: "web" },
  });
};
const formPost = (fields: Record<string, string>) =>
  new Request(`http://web/admin/onboarding/new/${ID}/start`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin: "http://web", host: "web" },
  });
const ctx = { params: Promise.resolve({ extractionId: ID }) };

beforeEach(() => {
  vi.stubEnv("ONBOARDING_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("API_BASE_URL", "http://api.internal:4000");
  jar.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("(M11) new onboarding from an offer letter (web)", () => {
  it("pages require a session; handlers redirect to login without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await redirectOf(NewPage({ searchParams: Promise.resolve({}) }))).toBe(
      "/admin/onboarding/login",
    );
    expect(await redirectOf(ReviewPage({ ...ctx, searchParams: Promise.resolve({}) }))).toBe(
      "/admin/onboarding/login",
    );
    const res = await upload(multipart(new File([pdf], "offer.pdf", { type: "application/pdf" })));
    expect(res.headers.get("location")).toBe("/admin/onboarding/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upload page is a plain multipart form (no token field, no client script)", async () => {
    signIn();
    const fetchMock = vi.fn(async () => Response.json({ active: true }));
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(await NewPage({ searchParams: Promise.resolve({}) }));
    // The page confirms with the API that the session is still active (not logged out).
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://api.internal:4000/admin/operator-sessions/current");
    expect((init.headers as Record<string, string>)["x-operator-session"]).toBeTruthy();
    expect(html).toContain('action="/admin/onboarding/new/upload"');
    expect(html).toMatch(/enctype="multipart\/form-data"/i);
    expect(html).toContain('type="file"');
    expect(html).not.toMatch(/type="password"|Operator token/);
  });

  it("upload page sends a logged-out (revoked) session back to login", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "OPERATOR_UNAUTHORIZED", message: "x" }, { status: 401 }),
      ),
    );
    expect(await redirectOf(NewPage({ searchParams: Promise.resolve({}) }))).toBe(
      "/admin/onboarding/login?error=expired",
    );
  });

  it("upload forwards exactly the PDF bytes with the server token and session; redirects to review", async () => {
    signIn();
    const fetchMock = vi.fn(async () => Response.json(view(), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await upload(multipart(new File([pdf], "offer.pdf", { type: "application/pdf" })));
    expect([res.status, res.headers.get("location")]).toEqual([303, `/admin/onboarding/new/${ID}`]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://api.internal:4000/admin/offer-letters");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "x-operator-id": "hr.alice",
      "x-operator-session": verifySessionValue(cookie, ADMIN_TOKEN)!.nonce,
      "content-type": "application/pdf",
    });
    expect(Buffer.from(init.body as Buffer).equals(Buffer.from(pdf))).toBe(true);
  });

  it("upload refuses no file, non-PDFs, oversized files and cross-site posts before the API", async () => {
    signIn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await upload(multipart(null))).headers.get("location")).toContain("error=NO_FILE");
    const text = new File(["hello"], "offer.pdf", { type: "application/pdf" });
    expect((await upload(multipart(text))).headers.get("location")).toContain(
      "error=INVALID_DOCUMENT",
    );
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.pdf", {
      type: "application/pdf",
    });
    expect((await upload(multipart(big))).headers.get("location")).toContain(
      "error=PAYLOAD_TOO_LARGE",
    );
    for (const bytes of ["%PDF-1.7\n1 0 obj << /Broken", "%PDF-1.4\n% truncated, no end marker"]) {
      const malformed = new File([bytes], "offer.pdf", { type: "application/pdf" });
      expect((await upload(multipart(malformed))).headers.get("location")).toContain(
        "error=INVALID_DOCUMENT",
      );
    }
    const okFile = new File([pdf], "offer.pdf", { type: "application/pdf" });
    expect((await upload(multipart(okFile, "https://evil.test"))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("review pre-fills the AI proposal but never pre-selects the access facts", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(view())),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ ...ctx, searchParams: Promise.resolve({}) }),
    );
    for (const v of [
      'value="Ada"',
      'value="ada@example.com"',
      'value="Backend Software Engineer"',
      'value="Sam Lead"',
    ]) {
      expect(html).toContain(v);
    }
    expect(html).toContain("Compensation or personal details were removed");
    for (const name of ["departmentCode", "roleFamilyCode", "employmentType"]) {
      const select = html.match(
        new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`),
      )![1]!;
      expect(select).toMatch(/<option value="" disabled="" selected="">Choose…<\/option>/);
      expect(select.match(/selected=""/g)).toHaveLength(1);
    }
    const box = html.match(/<input[^>]*name="offerSignedAndCleared"[^>]*>/)![0];
    for (const attr of ['type="checkbox"', 'value="true"', 'required=""'])
      expect(box).toContain(attr);
    expect(html).not.toContain(ADMIN_TOKEN);
  });

  it("an unreadable letter's empty proposal leaves every field to the operator", async () => {
    signIn();
    const empty = view();
    empty.proposal = {
      isOfferLetter: false,
      firstName: null,
      lastName: null,
      workEmail: null,
      jobTitle: null,
      department: null,
      managerName: null,
      startDate: null,
      jobSummary: null,
      warnings: ["UNREADABLE_DOCUMENT"],
    } as never;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(empty)),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ ...ctx, searchParams: Promise.resolve({}) }),
    );
    for (const name of ["firstName", "lastName", "email", "role", "department", "managerId"]) {
      const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))![0];
      expect(input).toContain('required=""');
      expect(input).toMatch(/value=""|^(?![\s\S]*value=)/);
    }
    expect(html).toContain("couldn&#x27;t be read");
    expect(html.match(/<option value="" disabled="" selected="">/g)).toHaveLength(3);
  });

  it("start without the attestation never calls the API", async () => {
    signIn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await start(
      formPost({
        firstName: "Ada",
        lastName: "Example",
        email: "ada@example.com",
        role: "Engineer",
        department: "Engineering",
        managerId: "Sam Lead",
        departmentCode: "ENGINEERING",
        roleFamilyCode: "SOFTWARE_ENGINEER",
        employmentType: "FULL_TIME",
      }),
      ctx,
    );
    expect(res.headers.get("location")).toBe(
      `/admin/onboarding/new/${ID}?error=ATTESTATION_REQUIRED`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("review of a submitted letter links to its workflow instead of the form", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(view("SUBMITTED", WF))),
    );
    const html = renderToStaticMarkup(
      await ReviewPage({ ...ctx, searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain(`href="/admin/onboarding/${WF}"`);
    expect(html).not.toContain(`action="/admin/onboarding/new/${ID}/start"`);
  });

  it("start sends only the listed fields (attestation true only when ticked) and opens the workflow", async () => {
    signIn();
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          extractionId: ID,
          eventId: `offer-letter:${ID}`,
          workflowId: WF,
          workflowCreated: true,
          duplicate: false,
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fields = {
      firstName: " Ada ",
      lastName: "Example",
      email: "ada@example.com",
      role: "Backend Software Engineer",
      department: "Engineering",
      managerId: "Sam Lead",
      jobDescription: "Builds backend services.",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
      offerSignedAndCleared: "true",
      salary: "$1",
    };
    const res = await start(formPost(fields), ctx);
    expect(res.headers.get("location")).toBe(`/admin/onboarding/${WF}`);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://api.internal:4000/admin/offer-letters/${ID}/start`);
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ firstName: "Ada", offerSignedAndCleared: true });
    expect(sent).not.toHaveProperty("salary");
    // Any value other than the ticked box's "true" is no attestation: no second API call.
    await start(formPost({ ...fields, offerSignedAndCleared: "yes" }), ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("start maps API errors to fixed codes on the review page", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "INVALID_PAYLOAD", message: "<b>x</b>" }, { status: 400 }),
      ),
    );
    const res = await start(formPost({ firstName: "x", offerSignedAndCleared: "true" }), ctx);
    expect(res.headers.get("location")).toBe(`/admin/onboarding/new/${ID}?error=INVALID_PAYLOAD`);
  });
});
