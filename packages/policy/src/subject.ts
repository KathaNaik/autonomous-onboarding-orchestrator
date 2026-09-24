import { EmployeeFactsSchema } from "@aoo/shared";
import { PolicyError } from "./errors.js";
import { PolicySubjectSchema, type PolicySubject } from "./schema.js";

/** The persisted employee fields the adapter reads (structurally matches the `employees` row). */
export interface EmployeeFactsRecord {
  readonly hrisEmployeeId: string;
  readonly departmentCode: string | null;
  readonly roleFamilyCode: string | null;
  readonly employmentType: string | null;
}

/**
 * Maps a persisted employee to the policy input. It renames fields only: values are passed
 * through unchanged and must already be canonical. Missing facts (legacy rows) throw
 * INCOMPLETE_SUBJECT and invalid ones INVALID_REQUEST; nothing is inferred or defaulted.
 */
export function policySubjectFromEmployee(employee: EmployeeFactsRecord): PolicySubject {
  const { hrisEmployeeId, departmentCode, roleFamilyCode, employmentType } = employee;
  const missing = Object.entries({ departmentCode, roleFamilyCode, employmentType })
    .filter(([, value]) => value === null || value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new PolicyError(
      "INCOMPLETE_SUBJECT",
      `employee ${hrisEmployeeId} has no canonical ${missing.join(", ")}; it can't be evaluated`,
      { issues: missing.map((key) => `${key}: missing`) },
    );
  }
  const facts = EmployeeFactsSchema.safeParse({ departmentCode, roleFamilyCode, employmentType });
  if (!facts.success) {
    const issues = facts.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`);
    throw new PolicyError(
      "INVALID_REQUEST",
      `employee ${hrisEmployeeId} has invalid canonical facts: ${issues.join("; ")}`,
      { issues },
    );
  }
  return Object.freeze(
    PolicySubjectSchema.parse({
      employeeId: hrisEmployeeId,
      department: facts.data.departmentCode,
      roleFamily: facts.data.roleFamilyCode,
      employmentType: facts.data.employmentType,
    }),
  );
}
