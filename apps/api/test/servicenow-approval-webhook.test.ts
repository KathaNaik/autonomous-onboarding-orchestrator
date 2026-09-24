import { ApprovalProcessingError, type ApprovalService } from "@aoo/orchestrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  CALLBACK_SECRET,
  callbackEnv,
  callbackPayload,
  signedCallback,
} from "./callback-helpers.js";
import { TEST_SECRET, testConfig } from "./helpers.js";

const recordServiceNowCallback = vi.fn<ApprovalService["recordServiceNowCallback"]>();
const approvals = { recordServiceNowCallback } as unknown as ApprovalService;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig(callbackEnv), { approvals });
});
afterAll(() => app.close());
beforeEach(() => {
  recordServiceNowCallback.mockReset();
  recordServiceNowCallback.mockResolvedValue({
    callbackEventId: "0b0f7c1e-4a5c-4e8e-9a51-7a4a3f0f6d11",
    duplicate: false,
  });
});

const post = (req: { body: string; headers: Record<string, string> }, target = app) =>
  target.inject({
    method: "POST",
    url: "/webhooks/servicenow/approvals",
    payload: req.body,
    headers: req.headers,
  });

function expectRejected(res: Awaited<ReturnType<typeof post>>, status: number, error: string) {
  expect(res.statusCode).toBe(status);
  expect(res.json()).toMatchObject({ status: "rejected", error });
  expect(recordServiceNowCallback).not.toHaveBeenCalled();
}

describe("POST /webhooks/servicenow/approvals", () => {
  it("records an authenticated callback and returns 202 (no decision is made here)", async () => {
    const payload = callbackPayload();
    const res = await post(signedCallback(payload));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted", eventId: payload.eventId, duplicate: false });
    expect(recordServiceNowCallback).toHaveBeenCalledWith(payload);
  });

  it("acknowledges a duplicate delivery as accepted", async () => {
    recordServiceNowCallback.mockResolvedValue({
      callbackEventId: "0b0f7c1e-4a5c-4e8e-9a51-7a4a3f0f6d11",
      duplicate: true,
    });
    expect((await post(signedCallback(callbackPayload()))).json()).toMatchObject({
      duplicate: true,
    });
  });

  it("rejects missing, invalid and stale authentication", async () => {
    const req = signedCallback(callbackPayload());
    const { ["x-aoo-signature"]: _s, ...noSig } = req.headers;
    expectRejected(await post({ ...req, headers: noSig }), 401, "AUTH_MISSING");
    expectRejected(
      await post(signedCallback(callbackPayload(), { secret: TEST_SECRET })),
      401,
      "AUTH_INVALID",
    );
    expectRejected(
      await post({ ...req, body: req.body.replace("OAR0001234", "OAR0009999") }),
      401,
      "AUTH_INVALID",
    );
    expectRejected(
      await post(signedCallback(callbackPayload(), { timestamp: Date.now() - 10 * 60_000 })),
      401,
      "AUTH_STALE",
    );
  });

  it("rejects malformed JSON, invalid payloads (without echoing values) and wrong content types", async () => {
    expectRejected(await post(signedCallback("{nope")), 400, "MALFORMED_JSON");
    const res = await post(
      signedCallback(callbackPayload({ sysId: "NOT-A-SYS-ID-secret-value", number: "x" })),
    );
    expectRejected(res, 400, "INVALID_PAYLOAD");
    expect(res.json().message).toContain("sysId");
    expect(res.body).not.toContain("NOT-A-SYS-ID-secret-value");
    const text = signedCallback(callbackPayload());
    expectRejected(
      await post({ ...text, headers: { ...text.headers, "content-type": "text/plain" } }),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });

  it("rejects callbacks from an unexpected instance or table", async () => {
    expectRejected(
      await post(signedCallback(callbackPayload({ instance: "dev999999" }))),
      422,
      "UNEXPECTED_SOURCE",
    );
    expectRejected(
      await post(signedCallback(callbackPayload({ table: "x_other_table" }))),
      422,
      "UNEXPECTED_SOURCE",
    );
  });

  it("maps a reused event id with different content to 409, and persistence failure to 500", async () => {
    recordServiceNowCallback.mockRejectedValueOnce(
      new ApprovalProcessingError("EVENT_ID_CONFLICT", false, "event id reused"),
    );
    expect((await post(signedCallback(callbackPayload()))).statusCode).toBe(409);
    recordServiceNowCallback.mockRejectedValueOnce(new Error("connection refused"));
    const res = await post(signedCallback(callbackPayload()));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "INTERNAL_ERROR" });
  });

  it("never logs the secret, signature, auth headers, cookies or payload values", async () => {
    const lines: string[] = [];
    const logged = await buildApp(
      testConfig({ ...callbackEnv, LOG_LEVEL: "info" }),
      { approvals },
      { logStream: { write: (line: string) => void lines.push(line) } },
    );
    try {
      const req = signedCallback(
        callbackPayload({ employeeName: "Jane Secret-Employee", ssn: "123-45-6789" }),
      );
      await post(
        {
          ...req,
          headers: {
            ...req.headers,
            authorization: "Bearer leaked-token-xyz",
            cookie: "JSESSIONID=cookie-abc",
          },
        },
        logged,
      );
      await post(signedCallback(callbackPayload(), { secret: TEST_SECRET }), logged);
    } finally {
      await logged.close();
    }
    const text = lines.join("");
    expect(text).toContain("servicenow approval callback recorded");
    for (const secret of [
      CALLBACK_SECRET,
      "leaked-token-xyz",
      "cookie-abc",
      "Jane Secret-Employee",
      "123-45-6789",
      "x-aoo-signature",
      "v1=",
    ]) {
      expect(text).not.toContain(secret);
    }
    // Unknown fields (employee data) never reach the service either.
    expect(recordServiceNowCallback.mock.calls[0]![0]).not.toHaveProperty("employeeName");
  });
});

describe("callback configuration", () => {
  it("the endpoint does not exist unless configured", async () => {
    const plain = await buildApp(testConfig());
    try {
      expect((await post(signedCallback(callbackPayload()), plain)).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it("requires all three settings together and a dedicated secret", () => {
    const base = {
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      HRIS_WEBHOOK_SECRET: TEST_SECRET,
    };
    expect(() => loadConfig({ ...base, SERVICENOW_CALLBACK_SECRET: CALLBACK_SECRET })).toThrow(
      /together/,
    );
    expect(() =>
      loadConfig({ ...base, ...callbackEnv, SERVICENOW_CALLBACK_SECRET: TEST_SECRET }),
    ).toThrow(/differ from HRIS/);
    expect(() =>
      loadConfig({ ...base, ...callbackEnv, SERVICENOW_PASSWORD: CALLBACK_SECRET }),
    ).toThrow(/ServiceNow API password/);
    expect(() =>
      loadConfig({ ...base, ...callbackEnv, SERVICENOW_CALLBACK_SECRET: "short" }),
    ).toThrow();
    expect(loadConfig({ ...base, ...callbackEnv }).SERVICENOW_CALLBACK_MAX_SKEW_MS).toBe(300_000);
  });
});
