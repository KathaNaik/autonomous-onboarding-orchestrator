import {
  HrisEventConflictError,
  HrisEventNotEligibleError,
  type HrisIntakeService,
} from "@aoo/orchestrator";
import { HrisWebhookAcceptedResponseSchema, HrisWebhookErrorResponseSchema } from "@aoo/shared";
import { HRIS_SIGNATURE_HEADER } from "@aoo/webhooks";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { offerSignedEvent, signedRequest, testConfig } from "./helpers.js";

const WORKFLOW_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const acceptOfferSigned = vi.fn<HrisIntakeService["acceptOfferSigned"]>();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testConfig({ HRIS_WEBHOOK_BODY_LIMIT_BYTES: "4096" }), {
    hrisIntake: { acceptOfferSigned },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  acceptOfferSigned.mockReset();
  acceptOfferSigned.mockResolvedValue({
    receiptId: "0b0f7c1e-4a5c-4e8e-9a51-7a4a3f0f6d11",
    workflowId: WORKFLOW_ID,
    workflowCreated: true,
    duplicate: false,
  });
});

const post = (req: { body: string; headers: Record<string, string> }) =>
  app.inject({ method: "POST", url: "/webhooks/hris", payload: req.body, headers: req.headers });

function expectRejected(res: Awaited<ReturnType<typeof post>>, status: number, error: string) {
  expect(res.statusCode).toBe(status);
  expect(HrisWebhookErrorResponseSchema.parse(res.json())).toMatchObject({
    status: "rejected",
    error,
  });
  expect(acceptOfferSigned).not.toHaveBeenCalled();
}

describe("POST /webhooks/hris: authentication", () => {
  it("rejects a request without a signature", async () => {
    const req = signedRequest(offerSignedEvent());
    delete (req.headers as Record<string, string>)[HRIS_SIGNATURE_HEADER];
    expectRejected(await post(req), 401, "SIGNATURE_MISSING");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const req = signedRequest(offerSignedEvent(), "wrong-secret-wrong-secret-wrong-secret!");
    expectRejected(await post(req), 401, "SIGNATURE_INVALID");
  });

  it("rejects a body modified after signing", async () => {
    const req = signedRequest(offerSignedEvent());
    expectRejected(
      await post({ ...req, body: req.body.replace("Engineering", "Finance") }),
      401,
      "SIGNATURE_INVALID",
    );
  });

  it("rejects a malformed signature header", async () => {
    const req = signedRequest(offerSignedEvent());
    req.headers[HRIS_SIGNATURE_HEADER] = "not-a-signature";
    expectRejected(await post(req), 401, "SIGNATURE_INVALID");
  });

  it("checks the signature before validating the payload", async () => {
    const req = signedRequest("{not json", "wrong-secret-wrong-secret-wrong-secret!");
    expectRejected(await post(req), 401, "SIGNATURE_INVALID");
  });
});

describe("POST /webhooks/hris: payload validation", () => {
  it("rejects malformed JSON even when correctly signed", async () => {
    expectRejected(await post(signedRequest("{not json")), 400, "MALFORMED_JSON");
  });

  it("rejects a signed payload that fails the schema", async () => {
    const res = await post(signedRequest({ ...offerSignedEvent(), employee: { firstName: "x" } }));
    expectRejected(res, 400, "INVALID_PAYLOAD");
    expect(res.json().message).toContain("employee");
  });

  it("rejects a non-JSON content type", async () => {
    const req = signedRequest(offerSignedEvent());
    req.headers["content-type"] = "text/plain";
    expectRejected(await post(req), 415, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects bodies over the configured limit without accepting them", async () => {
    const res = await post(signedRequest({ ...offerSignedEvent(), role: "x".repeat(5000) }));
    expect(res.statusCode).toBe(413);
    expect(acceptOfferSigned).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/hris: outcomes", () => {
  it("returns 202 with the workflow id once intake resolves", async () => {
    const event = offerSignedEvent();
    const res = await post(signedRequest(event));

    expect(res.statusCode).toBe(202);
    expect(HrisWebhookAcceptedResponseSchema.parse(res.json())).toEqual({
      status: "accepted",
      eventId: event.eventId,
      workflowId: WORKFLOW_ID,
      workflowCreated: true,
      duplicate: false,
    });
    expect(acceptOfferSigned).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.eventId }),
    );
  });

  it("accepts a content type with a charset parameter", async () => {
    const req = signedRequest(offerSignedEvent());
    req.headers["content-type"] = "application/json; charset=utf-8";
    expect((await post(req)).statusCode).toBe(202);
  });

  it("maps an ineligible event to 422", async () => {
    acceptOfferSigned.mockRejectedValue(new HrisEventNotEligibleError("e", "PENDING", "CLEARED"));
    const res = await post(signedRequest(offerSignedEvent({ offerStatus: "PENDING" })));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "NOT_ELIGIBLE" });
  });

  it("maps a reused event id with different content to 409", async () => {
    acceptOfferSigned.mockRejectedValue(new HrisEventConflictError("e"));
    const res = await post(signedRequest(offerSignedEvent()));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "EVENT_ID_CONFLICT" });
  });

  it("returns 500, never 202, when persistence fails", async () => {
    acceptOfferSigned.mockRejectedValue(new Error("connection refused"));
    const res = await post(signedRequest(offerSignedEvent()));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ status: "rejected", error: "INTERNAL_ERROR" });
  });
});

describe("routing", () => {
  it("does not affect JSON parsing on other routes", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("only accepts POST on the webhook path", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/hris" });
    expect(res.statusCode).toBe(404);
  });
});
