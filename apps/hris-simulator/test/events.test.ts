import { HrisOfferSignedEventSchema, isOnboardingEligible } from "@aoo/shared";
import { HRIS_SIGNATURE_HEADER, verifyHrisSignature } from "@aoo/webhooks";
import { describe, expect, it } from "vitest";
import { buildOfferSignedEvent, signEvent } from "../src/events.js";

const secret = "simulator-test-secret-0123456789abcdef";

describe("buildOfferSignedEvent", () => {
  it("produces a schema-valid, eligible event with unique ids", () => {
    const a = buildOfferSignedEvent();
    const b = buildOfferSignedEvent();
    expect(HrisOfferSignedEventSchema.parse(a)).toEqual(a);
    expect(isOnboardingEligible(a)).toBe(true);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.employeeId).not.toBe(b.employeeId);
  });

  it("applies overrides", () => {
    const event = buildOfferSignedEvent({
      eventId: "fixed",
      employeeId: "E-1",
      offerStatus: "PENDING",
      employee: { email: "fixed@example.com" },
    });
    expect(event).toMatchObject({
      eventId: "fixed",
      employeeId: "E-1",
      offerStatus: "PENDING",
      employee: { email: "fixed@example.com" },
    });
    expect(isOnboardingEligible(event)).toBe(false);
  });
});

describe("signEvent", () => {
  it("signs the exact serialized body with the shared protocol", () => {
    const req = signEvent(buildOfferSignedEvent(), secret);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(verifyHrisSignature(req.body, req.headers[HRIS_SIGNATURE_HEADER], secret)).toBe(true);
    expect(verifyHrisSignature(req.body, req.headers[HRIS_SIGNATURE_HEADER], `${secret}x`)).toBe(
      false,
    );
  });
});
