import { describe, expect, it } from "vitest";
import { GitHubIdentityClaimRequestSchema, HrisOfferSignedEventSchema } from "../src/index.js";

const hris = {
  eventId: "evt-1",
  eventType: "offer.signed",
  occurredAt: "2026-09-24T10:00:00.000Z",
  employeeId: "HRIS-1",
  employee: { firstName: "Grace", lastName: "Hopper", email: "grace@example.com" },
  role: "Software Engineer",
  department: "Engineering",
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
  managerId: "MGR-1",
  offerStatus: "SIGNED",
  candidateStatus: "CLEARED",
};

describe("GitHub identity is employee input, not an HRIS fact (M7B)", () => {
  it("the HRIS contract has no githubLogin: it is stripped like any unknown field", () => {
    const parsed = HrisOfferSignedEventSchema.parse({ ...hris, githubLogin: "octocat" });
    expect(parsed).not.toHaveProperty("githubLogin");
    expect(Object.keys(HrisOfferSignedEventSchema.shape ?? {})).not.toContain("githubLogin");
  });

  it.each(["octocat", "Octo-Cat", "a", "a".repeat(39), "user-123"])("accepts %j", (login) => {
    expect(GitHubIdentityClaimRequestSchema.parse({ githubLogin: login })).toEqual({
      githubLogin: login,
    });
  });

  it.each([
    "",
    " octocat",
    "octocat ",
    "octo_cat",
    "-octocat",
    "octocat-",
    "octo--cat",
    "a".repeat(40),
    "<script>",
    "grace@example.com",
    42,
    null,
    { login: "octocat" },
  ])("rejects %j", (login) => {
    expect(GitHubIdentityClaimRequestSchema.safeParse({ githubLogin: login }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(
      GitHubIdentityClaimRequestSchema.safeParse({ githubLogin: "octocat", verified: true })
        .success,
    ).toBe(false);
  });
});
