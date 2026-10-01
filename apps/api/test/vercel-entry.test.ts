import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_SECRET, offerSignedEvent, signedRequest } from "./helpers.js";

async function serve(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { default: handler } = await import("../src/vercel.js");
  const server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, close: () => server.close() };
}

const env = {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  HRIS_WEBHOOK_SECRET: TEST_SECRET,
};

afterEach(() => vi.unstubAllEnvs());

describe("(M10) Vercel function entry for the API", () => {
  it("serves the same Fastify app (health, request ids) without listen()", async () => {
    const s = await serve(env);
    try {
      const res = await fetch(`${s.base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
      // No CORS: the API never grants cross-origin browser access.
      const cors = await fetch(`${s.base}/health`, { headers: { origin: "https://evil.test" } });
      expect(cors.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      s.close();
    }
  });

  it("passes the exact raw body to the signed HRIS webhook (authentication still enforced)", async () => {
    const s = await serve(env);
    try {
      const req = signedRequest(offerSignedEvent(), "wrong-secret-wrong-secret-wrong-secret!");
      const res = await fetch(`${s.base}/webhooks/hris`, {
        method: "POST",
        headers: req.headers,
        body: req.body,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("SIGNATURE_INVALID");
    } finally {
      s.close();
    }
  });

  it("a production deployment with the public dev secret answers 500 with no detail", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await serve({
      ...env,
      VERCEL_ENV: "production",
      HRIS_WEBHOOK_SECRET: "dev-only-hris-webhook-secret-change-me",
    });
    try {
      const res = await fetch(`${s.base}/health`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "API_MISCONFIGURED" });
      expect(text).not.toContain("dev-only");
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("dev-only-hris");
    } finally {
      errors.mockRestore();
      s.close();
    }
  });
});
