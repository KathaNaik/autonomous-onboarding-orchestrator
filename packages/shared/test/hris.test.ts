import { describe, expect, it } from "vitest";
import { HrisOfferSignedEventSchema, isOnboardingEligible } from "../src/index.js";

const event = {
  eventId: "evt-1",
  eventType: "offer.signed",
  occurredAt: "2026-09-23T10:00:00Z",
  employeeId: "E-100",
  employee: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  role: "Software Engineer",
  department: "Engineering",
  managerId: "E-001",
  offerStatus: "SIGNED",
  candidateStatus: "CLEARED",
};

describe("HrisOfferSignedEventSchema", () => {
  it("accepts a complete offer.signed event and strips unknown fields", () => {
    expect(HrisOfferSignedEventSchema.parse({ ...event, extra: 1 })).toEqual(event);
  });

  it.each([
    ["missing eventId", { ...event, eventId: undefined }],
    ["wrong event type", { ...event, eventType: "offer.created" }],
    ["bad email", { ...event, employee: { ...event.employee, email: "nope" } }],
    ["unknown offer status", { ...event, offerStatus: "MAYBE" }],
    ["non-ISO timestamp", { ...event, occurredAt: "yesterday" }],
    ["blank role", { ...event, role: "  " }],
  ])("rejects %s", (_, input) => {
    expect(HrisOfferSignedEventSchema.safeParse(input).success).toBe(false);
  });
});

describe("isOnboardingEligible", () => {
  it("requires a signed offer and a cleared candidate", () => {
    expect(isOnboardingEligible({ offerStatus: "SIGNED", candidateStatus: "CLEARED" })).toBe(true);
    expect(isOnboardingEligible({ offerStatus: "SIGNED", candidateStatus: "PENDING" })).toBe(false);
    expect(isOnboardingEligible({ offerStatus: "PENDING", candidateStatus: "CLEARED" })).toBe(
      false,
    );
    expect(isOnboardingEligible({ offerStatus: "RESCINDED", candidateStatus: "NOT_CLEARED" })).toBe(
      false,
    );
  });
});
