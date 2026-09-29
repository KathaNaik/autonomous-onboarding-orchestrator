import {
  FulfillmentCallbackError,
  type ServiceNowFulfillmentCallbackService,
} from "@aoo/orchestrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  CALLBACK_SECRET,
  callbackEnv,
  callbackPayload,
  signedCallback,
} from "./callback-helpers.js";
import { testConfig } from "./helpers.js";

const recordFulfillmentCallback =
  vi.fn<ServiceNowFulfillmentCallbackService["recordFulfillmentCallback"]>();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig(callbackEnv), {
    fulfillmentCallbacks: { recordFulfillmentCallback },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  recordFulfillmentCallback.mockReset().mockResolvedValue({ duplicate: false });
});

const fulfillmentPayload = (overrides: Record<string, unknown> = {}) => {
  const { claimedApprovalState: _ignored, ...base } = callbackPayload();
  return {
    ...base,
    correlationKey: "aoo-ful-0123456789abcdef",
    claimedFulfillmentState: "fulfilled",
    ...overrides,
  };
};
const post = (req: { body: string; headers: Record<string, string> }) =>
  app.inject({
    method: "POST",
    url: "/webhooks/servicenow/fulfillment",
    payload: req.body,
    headers: req.headers,
  });

describe("POST /webhooks/servicenow/fulfillment (notification only)", () => {
  it("records an authenticated notification and answers 202; it never decides anything itself", async () => {
    const payload = fulfillmentPayload();
    const res = await post(signedCallback(payload));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted", eventId: payload.eventId, duplicate: false });
    // The only effect is recording the identifiers (the claim is passed as a diagnostic hint).
    expect(recordFulfillmentCallback).toHaveBeenCalledWith(payload);
  });

  it("rejects missing, wrong and stale signatures before touching the service", async () => {
    const payload = fulfillmentPayload();
    const good = signedCallback(payload);
    const missing = await post({
      body: good.body,
      headers: { "content-type": "application/json" },
    });
    expect([missing.statusCode, missing.json().error]).toEqual([401, "AUTH_MISSING"]);
    const wrong = await post(signedCallback(payload, { secret: `${CALLBACK_SECRET}-wrong` }));
    expect([wrong.statusCode, wrong.json().error]).toEqual([401, "AUTH_INVALID"]);
    const stale = await post(signedCallback(payload, { timestamp: Date.now() - 3_600_000 }));
    expect([stale.statusCode, stale.json().error]).toEqual([401, "AUTH_STALE"]);
    expect(recordFulfillmentCallback).not.toHaveBeenCalled();
  });

  it("validates payload and source, and maps unknown tickets and conflicts", async () => {
    const bad = await post(signedCallback({ ...fulfillmentPayload(), sysId: "not-a-sys-id" }));
    expect([bad.statusCode, bad.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    const source = await post(signedCallback(fulfillmentPayload({ instance: "dev999999" })));
    expect([source.statusCode, source.json().error]).toEqual([422, "UNEXPECTED_SOURCE"]);
    for (const [code, status] of [
      ["UNKNOWN_TICKET", 404],
      ["IDENTITY_MISMATCH", 409],
      ["EVENT_ID_CONFLICT", 409],
    ] as const) {
      recordFulfillmentCallback.mockRejectedValueOnce(new FulfillmentCallbackError(code, "x"));
      const res = await post(signedCallback(fulfillmentPayload()));
      expect([res.statusCode, res.json().error]).toEqual([status, code]);
    }
  });

  it("is not registered without the callback configuration", async () => {
    const bare = await buildApp(testConfig(), {
      fulfillmentCallbacks: { recordFulfillmentCallback },
    });
    const res = await bare.inject({
      method: "POST",
      url: "/webhooks/servicenow/fulfillment",
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
