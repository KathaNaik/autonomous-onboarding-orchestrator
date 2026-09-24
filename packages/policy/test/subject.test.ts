import { describe, expect, it } from "vitest";
import { loadPolicyRegistry, policySubjectFromEmployee } from "../src/index.js";
import { catalogRef, policyError } from "./helpers.js";

const employee = {
  hrisEmployeeId: "TEST-EMP-0002",
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SRE",
  employmentType: "CONTRACTOR",
};

describe("policySubjectFromEmployee", () => {
  it("renames fields and passes canonical values through unchanged", () => {
    const subject = policySubjectFromEmployee(employee);
    expect(subject).toEqual({
      employeeId: "TEST-EMP-0002",
      department: "ENGINEERING",
      roleFamily: "SRE",
      employmentType: "CONTRACTOR",
    });
    expect(Object.isFrozen(subject)).toBe(true);
    // The result is a valid policy input.
    const decision = loadPolicyRegistry().current.evaluate({
      subject,
      catalog: catalogRef,
      resourceId: "aws-prod",
    });
    expect(decision.reasonCode).toBe("NON_EMPLOYEE_PRODUCTION_ACCESS_DENIED");
  });

  it("ignores display fields and other columns on the record", () => {
    const row = { ...employee, id: "uuid", email: "x@example.com", role: "Anything at all" };
    expect(policySubjectFromEmployee(row)).toEqual(policySubjectFromEmployee(employee));
  });

  it("refuses incomplete legacy employees", () => {
    const legacy = {
      hrisEmployeeId: "LEGACY-1",
      departmentCode: null,
      roleFamilyCode: null,
      employmentType: null,
    };
    const err = policyError(() => policySubjectFromEmployee(legacy));
    expect(err.code).toBe("INCOMPLETE_SUBJECT");
    expect(err.issues).toEqual([
      "departmentCode: missing",
      "roleFamilyCode: missing",
      "employmentType: missing",
    ]);
    expect(
      policyError(() => policySubjectFromEmployee({ ...employee, employmentType: null })).issues,
    ).toEqual(["employmentType: missing"]);
  });

  it.each([
    ["a non-canonical spelling", { roleFamilyCode: "SITE_RELIABILITY_ENGINEER" }],
    ["a lower-case code", { departmentCode: "engineering" }],
    ["a display string", { departmentCode: "Engineering" }],
    ["a disallowed combination", { departmentCode: "SALES" }],
    ["an employment type outside the canonical set", { employmentType: "INTERN" }],
  ])("never reinterprets %s", (_, patch) => {
    expect(policyError(() => policySubjectFromEmployee({ ...employee, ...patch })).code).toBe(
      "INVALID_REQUEST",
    );
  });
});
