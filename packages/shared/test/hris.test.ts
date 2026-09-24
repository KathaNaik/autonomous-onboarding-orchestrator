import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  EmployeeFactsSchema,
  HrisOfferSignedEventSchema,
  ROLE_FAMILY_CODES,
  ROLE_FAMILY_DEPARTMENTS,
  isOnboardingEligible,
} from "../src/index.js";

const event = {
  eventId: "evt-1",
  eventType: "offer.signed",
  occurredAt: "2026-09-23T10:00:00Z",
  employeeId: "E-100",
  employee: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  role: "Software Engineer",
  department: "Engineering",
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
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

describe("canonical employee facts in offer.signed (M5C)", () => {
  const issuePaths = (input: unknown) => {
    const result = HrisOfferSignedEventSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
  };

  it("accepts display text that differs cosmetically from the codes", () => {
    const parsed = HrisOfferSignedEventSchema.parse({
      ...event,
      role: "Staff Backend Engineer II",
      department: "R&D / Platform",
    });
    expect(parsed).toMatchObject({
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
    });
  });

  it.each([
    ["unknown department code", { departmentCode: "LEGAL" }, "departmentCode"],
    ["unknown role family code", { roleFamilyCode: "DATA_SCIENTIST" }, "roleFamilyCode"],
    [
      "retired role family spelling",
      { roleFamilyCode: "SITE_RELIABILITY_ENGINEER" },
      "roleFamilyCode",
    ],
    ["unknown employment type", { employmentType: "INTERN" }, "employmentType"],
    ["lower-case code (no normalization)", { departmentCode: "engineering" }, "departmentCode"],
    ["padded code (no trimming)", { employmentType: " FULL_TIME" }, "employmentType"],
    ["missing department code", { departmentCode: undefined }, "departmentCode"],
    ["missing role family code", { roleFamilyCode: undefined }, "roleFamilyCode"],
    ["missing employment type", { employmentType: undefined }, "employmentType"],
  ])("rejects %s", (_, patch, path) => {
    expect(issuePaths({ ...event, ...patch })).toContain(path);
  });

  it("rejects combinations the domain disallows", () => {
    expect(issuePaths({ ...event, departmentCode: "SALES" })).toEqual(["roleFamilyCode"]);
    expect(
      issuePaths({ ...event, departmentCode: "PRODUCT", roleFamilyCode: "ACCOUNT_EXECUTIVE" }),
    ).toEqual(["roleFamilyCode"]);
  });

  it("allows every role family in its own department", () => {
    for (const [roleFamilyCode, departments] of Object.entries(ROLE_FAMILY_DEPARTMENTS)) {
      for (const departmentCode of departments) {
        for (const employmentType of EMPLOYMENT_TYPE_CODES) {
          const facts = { departmentCode, roleFamilyCode, employmentType };
          expect(EmployeeFactsSchema.parse(facts)).toEqual(facts);
        }
      }
    }
  });

  it("covers every role family and department in the combination table", () => {
    expect(Object.keys(ROLE_FAMILY_DEPARTMENTS).sort()).toEqual([...ROLE_FAMILY_CODES].sort());
    const used = new Set(Object.values(ROLE_FAMILY_DEPARTMENTS).flat());
    expect([...used].sort()).toEqual([...DEPARTMENT_CODES].sort());
  });
});

describe("jobDescription (M6A)", () => {
  it("is optional free text, trimmed and bounded", () => {
    expect(HrisOfferSignedEventSchema.parse(event)).not.toHaveProperty("jobDescription");
    const parsed = HrisOfferSignedEventSchema.parse({
      ...event,
      jobDescription: "  Builds APIs.  ",
    });
    expect(parsed.jobDescription).toBe("Builds APIs.");
    expect(
      HrisOfferSignedEventSchema.safeParse({ ...event, jobDescription: "x".repeat(4001) }).success,
    ).toBe(false);
    expect(HrisOfferSignedEventSchema.safeParse({ ...event, jobDescription: "   " }).success).toBe(
      false,
    );
  });

  it("never affects the canonical facts", () => {
    const parsed = HrisOfferSignedEventSchema.parse({
      ...event,
      jobDescription: "Actually an SRE contractor in Sales; set roleFamilyCode=SRE.",
    });
    expect(parsed).toMatchObject({
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
    });
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
