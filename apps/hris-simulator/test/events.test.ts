import { HrisOfferSignedEventSchema, isOnboardingEligible } from "@aoo/shared";
import { HRIS_SIGNATURE_HEADER, HRIS_TIMESTAMP_HEADER, verifyHrisRequest } from "@aoo/webhooks";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HIRE_PROFILES,
  HIRE_PROFILE_NAMES,
  buildOfferSignedEvent,
  loadEvent,
  saveEvent,
  signEvent,
} from "../src/events.js";

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

describe("canonical facts (M5C)", () => {
  it("generates valid canonical facts for every profile", () => {
    for (const profile of HIRE_PROFILE_NAMES) {
      const event = buildOfferSignedEvent({}, profile);
      expect(event).toMatchObject(HIRE_PROFILES[profile]);
      expect(HrisOfferSignedEventSchema.parse(event)).toEqual(event);
    }
  });

  it.each([
    ["engineering", "ENGINEERING", "SOFTWARE_ENGINEER", "FULL_TIME"],
    ["contractor", "ENGINEERING", "SOFTWARE_ENGINEER", "CONTRACTOR"],
    ["sales", "SALES", "ACCOUNT_EXECUTIVE", "FULL_TIME"],
    ["product", "PRODUCT", "PRODUCT_MANAGER", "FULL_TIME"],
  ] as const)("simulates a %s hire", (profile, departmentCode, roleFamilyCode, employmentType) => {
    expect(buildOfferSignedEvent({}, profile)).toMatchObject({
      departmentCode,
      roleFamilyCode,
      employmentType,
    });
  });

  it("lets explicit overrides win over the profile, and rejects invalid combinations", () => {
    const sre = buildOfferSignedEvent(
      { roleFamilyCode: "SRE", employmentType: "CONTRACTOR" },
      "engineering",
    );
    expect(sre).toMatchObject({
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SRE",
      employmentType: "CONTRACTOR",
    });
    expect(() => buildOfferSignedEvent({ departmentCode: "SALES" }, "engineering")).toThrow(
      /not allowed in department SALES/,
    );
  });

  it("preserves canonical facts through save and replay, byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "hris-sim-"));
    try {
      const file = join(dir, "evt.json");
      const event = buildOfferSignedEvent({}, "contractor");
      saveEvent(file, event);
      const replayed = loadEvent(file);
      expect(replayed).toEqual(event);
      expect(replayed.jobDescription).toBe(HIRE_PROFILES.contractor.jobDescription);
      expect(replayed).toMatchObject({
        employmentType: "CONTRACTOR",
        roleFamilyCode: "SOFTWARE_ENGINEER",
      });
      expect(signEvent(replayed, secret).body).toBe(signEvent(event, secret).body);
      expect(JSON.parse(readFileSync(file, "utf8")).departmentCode).toBe("ENGINEERING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("signEvent", () => {
  it("signs the exact serialized body with the shared protocol", () => {
    const req = signEvent(buildOfferSignedEvent(), secret);
    expect(req.headers["content-type"]).toBe("application/json");
    const check = (key: string) =>
      verifyHrisRequest({
        rawBody: req.body,
        timestamp: req.headers[HRIS_TIMESTAMP_HEADER],
        signature: req.headers[HRIS_SIGNATURE_HEADER],
        secret: key,
      }).ok;
    expect(check(secret)).toBe(true);
    expect(check(`${secret}x`)).toBe(false);
  });
});
