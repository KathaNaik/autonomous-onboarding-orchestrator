import { createServer, type Server } from "node:http";
import { once } from "node:events";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadWorkerFunctionConfig, maxHandlerMs } from "../src/config.js";
import { createQStashVerifier } from "../src/qstash.js";
import {
  createWorkerFunctionHandler,
  environmentRuntime,
  type WorkerFunctionRuntime,
} from "../src/serverless.js";
import type { WorkerServices } from "../src/services.js";
import { SCHEDULE_BODY, WORKER_URL, signQStash, testSigningKeys } from "./qstash-signing.js";

const keys = testSigningKeys();
const runOnce = vi.fn();
const enqueueDueWakes = vi.fn();
const servicesFactory = vi.fn(
  () =>
    ({
      runner: { runOnce },
      coordinator: { enqueueDueWakes },
      onboardingPlans: undefined,
    }) as unknown as WorkerServices,
);
const runtime: WorkerFunctionRuntime = {
  logger: pino({ level: "silent" }),
  verifier: createQStashVerifier({
    currentSigningKey: keys.current,
    nextSigningKey: keys.next,
    url: WORKER_URL,
  }),
  batch: { maxEvents: 50, deadlineMs: 5_000 },
  services: servicesFactory,
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void createWorkerFunctionHandler(() => runtime)(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  servicesFactory.mockClear();
  runOnce.mockReset().mockResolvedValue({
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
  });
  enqueueDueWakes.mockReset().mockResolvedValue({ enqueued: 0 });
});

const post = (body: string, signature?: string, method = "POST") =>
  fetch(`${base}/api/worker/run`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(signature !== undefined && { "upstash-signature": signature }),
    },
    ...(method === "POST" && { body }),
  });
const valid = (overrides: Partial<Parameters<typeof signQStash>[0]> = {}) =>
  signQStash({ key: keys.current, url: WORKER_URL, body: SCHEDULE_BODY, ...overrides });

describe("(M10) POST /api/worker/run authentication", () => {
  it.each([
    ["missing signature", undefined],
    ["malformed signature", "garbage"],
    [
      "wrong signing key",
      signQStash({ key: "k".repeat(40), url: WORKER_URL, body: SCHEDULE_BODY }),
    ],
    ["expired signature", "EXPIRED"],
    ["signature for another URL", "WRONG_URL"],
  ])("%s → 401 before any business work", async (_, sig) => {
    const signature =
      sig === "EXPIRED"
        ? valid({ now: Date.now() - 3_600_000, expiresInSeconds: 60 })
        : sig === "WRONG_URL"
          ? valid({ url: "https://other.test/api/worker/run" })
          : sig;
    const res = await post(SCHEDULE_BODY, signature);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED" }); // no crypto detail
    expect(servicesFactory).not.toHaveBeenCalled(); // no database pool, sweep or claim
    expect(runOnce).not.toHaveBeenCalled();
    expect(enqueueDueWakes).not.toHaveBeenCalled();
  });

  it("a valid signature over a different raw body → 401", async () => {
    const res = await post(`${SCHEDULE_BODY} `, valid());
    expect(res.status).toBe(401);
    expect(servicesFactory).not.toHaveBeenCalled();
  });

  it("GET → 405 and an oversized body → 413, both without work", async () => {
    expect((await post("", undefined, "GET")).status).toBe(405);
    expect((await post("x".repeat(5000), valid({ body: "x".repeat(5000) }))).status).toBe(413);
    expect(servicesFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["current", keys.current],
    ["next (rotation)", keys.next],
  ])("a valid delivery signed with the %s key runs one bounded batch", async (_, key) => {
    const res = await post(SCHEDULE_BODY, valid({ key }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", claimed: 0, stoppedBy: "IDLE", batches: 1 });
    expect(Object.keys(body)).not.toContain("error");
    expect(servicesFactory).toHaveBeenCalledOnce();
    expect(enqueueDueWakes).toHaveBeenCalledOnce();
  });

  it("a misconfigured function answers 500 without details", async () => {
    const broken = createServer(
      (req, res) =>
        void createWorkerFunctionHandler(() => {
          throw new Error("invalid worker function configuration: QSTASH_NEXT_SIGNING_KEY");
        })(req, res),
    ).listen(0, "127.0.0.1");
    await once(broken, "listening");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(
        `http://127.0.0.1:${(broken.address() as { port: number }).port}/api/worker/run`,
        { method: "POST", body: SCHEDULE_BODY },
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "WORKER_MISCONFIGURED" });
    } finally {
      errors.mockRestore();
      broken.close();
    }
  });
});

describe("(M10) worker function configuration", () => {
  const env = {
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    QSTASH_CURRENT_SIGNING_KEY: keys.current,
    QSTASH_NEXT_SIGNING_KEY: keys.next,
    WORKER_QSTASH_URL: WORKER_URL,
  };

  it("defaults fit Vercel Hobby: 230 s deadline + longest handler + margin ≤ 300 s", () => {
    const config = loadConfig({
      ...env,
      ONBOARDING_PLAN_RUN_LEASE_MS: "60000",
      ROLE_ACCESS_RUN_LEASE_MS: "60000",
    });
    const fn = loadWorkerFunctionConfig(config, env);
    expect(fn).toMatchObject({
      WORKER_RUN_DEADLINE_MS: 230_000,
      WORKER_FUNCTION_MAX_DURATION_MS: 300_000,
    });
    expect(fn.WORKER_RUN_DEADLINE_MS + maxHandlerMs(config) + 10_000).toBeLessThanOrEqual(300_000);
  });

  it("refuses a deadline that could outlive the platform limit (the 180 s run-lease defaults)", () => {
    expect(() => loadWorkerFunctionConfig(loadConfig(env), env)).toThrow(
      /exceeds WORKER_FUNCTION_MAX_DURATION_MS/,
    );
  });

  it("requires both signing keys and an https worker URL, naming variables only", () => {
    const config = loadConfig({
      ...env,
      ONBOARDING_PLAN_RUN_LEASE_MS: "60000",
      ROLE_ACCESS_RUN_LEASE_MS: "60000",
    });
    let message = "";
    try {
      loadWorkerFunctionConfig(config, {
        ...env,
        QSTASH_NEXT_SIGNING_KEY: "",
        WORKER_QSTASH_URL: "http://x.test",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("QSTASH_NEXT_SIGNING_KEY");
    expect(message).toContain("WORKER_QSTASH_URL");
    expect(message).not.toContain(keys.current);
  });

  it("does not need QSTASH_TOKEN at runtime and builds nothing until a request is verified", () => {
    const rt = environmentRuntime({
      ...env,
      ONBOARDING_PLAN_RUN_LEASE_MS: "60000",
      ROLE_ACCESS_RUN_LEASE_MS: "60000",
      LOG_LEVEL: "silent",
    })();
    expect(rt.batch).toEqual({ maxEvents: 500, deadlineMs: 230_000 });
  });
});
