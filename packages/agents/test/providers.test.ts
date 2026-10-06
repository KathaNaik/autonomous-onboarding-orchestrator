import { loadCatalogRegistry } from "@aoo/catalog";
import { describe, expect, it } from "vitest";
import {
  ModelProviderError,
  ROLE_ACCESS_EVAL_CASES,
  createOpenAIProvider,
  loadRoleAccessAgentConfig,
  scoreRoleAccessEval,
  type ModelRequest,
} from "../src/index.js";

const API_KEY = "sk-proj-test-0000000000000000000000000000";
const request: ModelRequest = {
  system: "system prompt",
  user: "user message",
  structuredOutput: { name: "role_access_recommendations", schema: { type: "object" } },
};

function providerWith(respond: (init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const provider = createOpenAIProvider(
    {
      apiKey: API_KEY,
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com",
      timeoutMs: 50,
      maxOutputTokens: 8192,
    },
    {
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return respond(init);
      }) as unknown as typeof fetch,
    },
  );
  return { provider, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const completed = (text: string, extra: Record<string, unknown> = {}) => ({
  status: "completed",
  model: "gpt-5.6-sol-2026-09-01",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ],
  usage: { input_tokens: 812, output_tokens: 34 },
  ...extra,
});

async function providerError(promise: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ModelProviderError) return err;
    throw err;
  }
  throw new Error("expected a ModelProviderError");
}

const signal = new AbortController().signal;

describe("OpenAI provider (Responses API)", () => {
  it("requests strict Structured Outputs with no tools, and returns output, usage and model", async () => {
    const { provider, seen } = providerWith(() =>
      json(200, completed(JSON.stringify({ recommendations: [] }))),
    );
    const response = await provider.generate(request, { signal });
    expect(response).toEqual({
      output: { recommendations: [] },
      usage: { inputTokens: 812, outputTokens: 34 },
      model: "gpt-5.6-sol-2026-09-01",
    });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toEqual({
      model: "gpt-5.6-sol",
      instructions: "system prompt",
      input: "user message",
      text: {
        format: {
          type: "json_schema",
          name: "role_access_recommendations",
          schema: { type: "object" },
          strict: true,
        },
      },
      max_output_tokens: 8192,
      store: false,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(provider.provider).toBe("openai");
    expect(provider.configId).toBe(
      "openai-responses/gpt-5.6-sol/structured=strict/max_output_tokens=8192",
    );
  });

  it.each([
    [429, "rate_limit_exceeded", "RATE_LIMITED", { "retry-after-ms": "2500" }, 2500],
    [429, "rate_limit_exceeded", "RATE_LIMITED", { "retry-after": "3" }, 3000],
    [429, "insufficient_quota", "BAD_REQUEST", {}, undefined],
    [500, "server_error", "PROVIDER_UNAVAILABLE", {}, undefined],
    [503, "", "PROVIDER_UNAVAILABLE", {}, undefined],
    [408, "", "TIMEOUT", {}, undefined],
    [401, "invalid_api_key", "AUTHENTICATION", {}, undefined],
    [403, "", "AUTHENTICATION", {}, undefined],
    [400, "invalid_request_error", "BAD_REQUEST", {}, undefined],
    [404, "model_not_found", "BAD_REQUEST", {}, undefined],
  ] as const)("maps HTTP %s (%s) to %s", async (status, code, category, headers, retryAfterMs) => {
    const { provider } = providerWith(() =>
      json(status, { error: { code, message: `leaked ${API_KEY}` } }, headers),
    );
    const err = await providerError(provider.generate(request, { signal }));
    expect([err.category, err.httpStatus, err.retryAfterMs]).toEqual([
      category,
      status,
      retryAfterMs,
    ]);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain("leaked");
  });

  it("maps network failures and timeouts without leaking the key", async () => {
    const network = providerWith(() => {
      throw new TypeError(`fetch failed for key ${API_KEY}`);
    });
    const netErr = await providerError(network.provider.generate(request, { signal }));
    expect(netErr.category).toBe("NETWORK");
    expect(netErr.message).not.toContain(API_KEY);

    const slow = providerWith(
      (init) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    expect((await providerError(slow.provider.generate(request, { signal }))).category).toBe(
      "TIMEOUT",
    );
  });

  it.each([
    [
      "an incomplete response",
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      "MALFORMED_OUTPUT",
    ],
    [
      "a refusal",
      {
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      },
      "MALFORMED_OUTPUT",
    ],
    [
      "no message output",
      { status: "completed", output: [{ type: "reasoning" }] },
      "MALFORMED_OUTPUT",
    ],
    ["non-JSON text", completed("Sure, access granted!"), "MALFORMED_OUTPUT"],
    [
      "a failed response",
      { status: "failed", error: { code: "server_error" }, output: [] },
      "PROVIDER_UNAVAILABLE",
    ],
  ] as const)("treats %s as %s", async (_, body, category) => {
    const { provider } = providerWith(() => json(200, body));
    expect((await providerError(provider.generate(request, { signal }))).category).toBe(category);
  });
});

describe("configuration", () => {
  it("requires OPENAI_API_KEY, names bad variables without echoing values, and has defaults", () => {
    expect(() => loadRoleAccessAgentConfig({})).toThrow(/OPENAI_API_KEY/);
    expect(() => loadRoleAccessAgentConfig({ ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() =>
      loadRoleAccessAgentConfig({ OPENAI_API_KEY: API_KEY, OPENAI_BASE_URL: "http://x.test" }),
    ).toThrow(/OPENAI_BASE_URL/);
    try {
      loadRoleAccessAgentConfig({ OPENAI_API_KEY: API_KEY, ROLE_ACCESS_AGENT_MAX_ATTEMPTS: "99" });
    } catch (err) {
      expect((err as Error).message).not.toContain(API_KEY);
    }
    expect(loadRoleAccessAgentConfig({ OPENAI_API_KEY: API_KEY })).toMatchObject({
      OPENAI_MODEL: "gpt-5.6-sol",
      OPENAI_BASE_URL: "https://api.openai.com",
      ROLE_ACCESS_AGENT_MAX_ATTEMPTS: 3,
      ROLE_ACCESS_AGENT_MAX_TOKENS: 8192,
    });
    expect(
      loadRoleAccessAgentConfig({ OPENAI_API_KEY: API_KEY, OPENAI_MODEL: "other-model" }),
    ).toMatchObject({ OPENAI_MODEL: "other-model" });
  });
});

describe("evaluation scoring (pure; not a substitute for live results)", () => {
  const catalog = loadCatalogRegistry().get("1.0.0");
  const byId = Object.fromEntries(ROLE_ACCESS_EVAL_CASES.map((c) => [c.id, c]));
  const out = (...ids: string[]) => ({
    recommendations: ids.map((resourceId) => ({
      resourceId,
      reasonCode: "ROLE_BASELINE",
      reason: "r",
      confidence: 0.8,
    })),
  });

  it("computes every reported metric", () => {
    const report = scoreRoleAccessEval(
      [
        {
          case: byId["backend-engineer"]!,
          rawOutput: out("github-org-membership", "github-team-backend"),
          outcome: "ok",
          latencyMs: 100,
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        {
          case: byId["prompt-injection"]!,
          rawOutput: out("aws-prod", "github-enterprise-admin", "aws-prod"),
          outcome: "INVALID_RECOMMENDATION",
          latencyMs: 300,
        },
        { case: byId["account-executive"]!, rawOutput: out(), outcome: "ok", latencyMs: 200 },
        { case: byId["sre"]!, rawOutput: "not json", outcome: "MALFORMED_OUTPUT", latencyMs: 400 },
      ],
      catalog,
    );
    expect(report).toMatchObject({
      totalCases: 4,
      schemaValidRate: 0.75,
      catalogValidRate: 0.5,
      mustIncludeRecall: 0.4,
      mustExcludeViolationRate: 0.25,
      hallucinatedResourceCount: 1,
      duplicateResourceCount: 1,
      emptyResultRate: 0.25,
      latencyMs: { average: 250, p50: 200, p95: 400 },
      tokens: { input: 10, output: 5 },
    });
  });

  it("covers every required case type", () => {
    expect(ROLE_ACCESS_EVAL_CASES.map((c) => c.id)).toEqual([
      "backend-engineer",
      "frontend-engineer",
      "sre",
      "engineering-manager",
      "product-manager",
      "account-executive",
      "engineering-contractor",
      "minimal-description",
      "prompt-injection",
    ]);
    for (const c of ROLE_ACCESS_EVAL_CASES) {
      expect(catalog.validateResourceIds([...c.mustInclude, ...c.mustExclude]).valid, c.id).toBe(
        true,
      );
      expect(
        c.mustInclude.filter((id) => c.mustExclude.includes(id)),
        c.id,
      ).toEqual([]);
    }
  });
});

describe("(M11) OpenAI provider: attached files", () => {
  it("sends a PDF as an input_file part before the text, still with no tools and store:false", async () => {
    const { provider, seen } = providerWith(() =>
      json(200, completed(JSON.stringify({ ok: true }))),
    );
    const signal = new AbortController().signal;
    await provider.generate(
      {
        ...request,
        files: [
          { filename: "offer-letter.pdf", mimeType: "application/pdf", dataBase64: "JVBERi0x" },
        ],
      },
      { signal },
    );
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "offer-letter.pdf",
            file_data: "data:application/pdf;base64,JVBERi0x",
          },
          { type: "input_text", text: "user message" },
        ],
      },
    ]);
    expect(body).toMatchObject({ store: false, instructions: "system prompt" });
    expect(body).not.toHaveProperty("tools");
  });
});
