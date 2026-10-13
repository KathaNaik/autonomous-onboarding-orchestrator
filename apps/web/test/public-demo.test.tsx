import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const { DEMO_SCENARIOS, DEMO_SLUGS, DemoScenarioSchema, demoScenario } =
  await import("@/lib/demo-data");
const { default: DemoIndex } = await import("@/app/demo/page");
const demoModule = await import("@/app/demo/[slug]/page");
const { default: DemoPage } = demoModule;
const { default: Home } = await import("@/app/page");

afterEach(() => vi.unstubAllGlobals());
const page = (slug: string) => DemoPage({ params: Promise.resolve({ slug }) });

describe("(M10) public synthetic demo", () => {
  it("landing page: Swift, the story, Try it, every demo scenario and the tech stack, in that order", () => {
    const html = renderToStaticMarkup(Home());
    const order = [
      ">Swift</h1>",
      "AOO · Autonomous Onboarding Orchestrator",
      "How it started",
      "It took me four weeks to finish onboarding at my current role.",
      ">Try it</a>",
      "Demo scenarios",
      "Tech stack",
    ].map((text) => html.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order.slice(2)).toEqual([...order.slice(2)].sort((a, b) => a - b));
    expect(order[0]).toBeLessThan(order[2]!);
    expect(html).toContain('href="/demo"');
    for (const s of DEMO_SCENARIOS) {
      expect(html).toContain(`href="/demo/${s.slug}"`);
      expect(html).toContain(s.title);
    }
    expect(html).toContain('href="/admin/onboarding/login"');
    expect(html).not.toMatch(/<form|<input|<script(?![^>]*src)/i);
  });

  it("renders the index and every scenario without any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const index = renderToStaticMarkup(DemoIndex());
    for (const slug of DEMO_SLUGS) {
      expect(index).toContain(`href="/demo/${slug}"`);
      const html = renderToStaticMarkup(await page(slug));
      expect(html).toContain(demoScenario(slug)!.title);
      expect(html).not.toMatch(/<form|<input|<button/i); // read-only: no controls at all
    }
    expect(renderToStaticMarkup(await page("completed"))).toContain("Day one");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scenarios read like the operator's workflow page", async () => {
    const text = (html: string) =>
      html
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ");
    const done = text(renderToStaticMarkup(await page("completed")));
    for (const t of [
      "Onboarding complete · 5 of 5 tools ready · first-month plan with",
      "Onboarding complete. Nothing left to do.",
      "Tools and access",
      "How access was decided",
      "First-month plan",
      "Activity",
    ])
      expect(done, t).toContain(t);
    const approval = text(renderToStaticMarkup(await page("awaiting-approval")));
    expect(approval).toContain("Waiting on: Approver in ServiceNow");
    expect(approval).not.toContain("aws-dev"); // no raw ids for tools outside the scenario
    expect(approval).toContain("Not granted");
    const invite = text(renderToStaticMarkup(await page("github-invitation-pending")));
    expect(invite).toContain("Invitation sent: the employee has to accept it on GitHub.");
    expect(invite).toContain("Starts after GitHub organization membership.");
    expect(invite).toContain("Not reached yet");
  });

  it("only the fixed slugs exist (static params, no dynamic lookup)", () => {
    expect(demoModule.dynamicParams).toBe(false);
    expect(demoModule.generateStaticParams()).toEqual(DEMO_SLUGS.map((slug) => ({ slug })));
  });

  it("fuzz: any other path segment is a 404 and never reaches a backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_./%:;'\"<>{}[]\\ ";
    const samples = [
      "",
      "Completed",
      "completed ",
      "../admin/onboarding",
      "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11",
      "%2e%2e%2fadmin",
      "completed?x=1",
      "constructor",
      "__proto__",
      "<script>alert(1)</script>",
    ];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rand() * 40);
      samples.push(
        Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""),
      );
    }
    for (const slug of samples) {
      if ((DEMO_SLUGS as readonly string[]).includes(slug)) continue;
      const outcome = await page(slug).then(
        () => "rendered",
        (e: { digest?: string }) => e.digest,
      );
      expect(outcome, slug).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(demoScenario(slug)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the stricter demo model carries no identifiers, contacts or secrets", () => {
    const text = JSON.stringify(DEMO_SCENARIOS);
    const forbidden: [string, RegExp][] = [
      ["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
      ["sys_id", /\b[0-9a-f]{32}\b/i],
      ["email", /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i],
      ["ticket", /\bOAR\d{4,}\b/],
      ["correlation key", /aoo-(test-)?(oar|ful)-/],
      ["HRIS id", /\bHRIS-|TEST-EMP/],
      ["github login", /kathanaik|octocat/i],
      ["provider id", /\b00[ug][A-Za-z0-9]{10,}\b/],
      ["url", /https?:\/\//],
      ["secret-like", /bearer|token|password|secret|ghp_|sk-/i],
    ];
    for (const [name, pattern] of forbidden) expect(text, name).not.toMatch(pattern);
    // The model is strict: unknown keys (e.g. a workflowId) are rejected.
    expect(() => DemoScenarioSchema.parse({ ...DEMO_SCENARIOS[0], workflowId: "x" })).toThrow();
  });

  it("demo code imports no API client, session, config or database module", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of [
      ...walk(join(root, "app", "demo")),
      join(root, "lib", "demo-data.ts"),
      join(root, "lib", "demo-model.ts"),
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(
        /onboarding-read-api|github-identity-api|dashboard-auth|operator-session|lib\/config|@aoo\/db|fetch\(/,
      );
    }
  });
});
