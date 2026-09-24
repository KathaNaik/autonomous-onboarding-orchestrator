import { z } from "zod";

/**
 * Canonical employee facts: the only employee attributes authorization may depend on. HRIS is
 * authoritative for them. They are never inferred from display text and never produced by an
 * agent. This module is the single source of the allowed values (HRIS contract, database checks
 * and the policy package all import it).
 */
export const DEPARTMENT_CODES = ["ENGINEERING", "PRODUCT", "SALES"] as const;
export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];

export const ROLE_FAMILY_CODES = [
  "SOFTWARE_ENGINEER",
  "SRE",
  "ENGINEERING_MANAGER",
  "PRODUCT_MANAGER",
  "ACCOUNT_EXECUTIVE",
] as const;
export type RoleFamilyCode = (typeof ROLE_FAMILY_CODES)[number];

export const EMPLOYMENT_TYPE_CODES = ["FULL_TIME", "CONTRACTOR"] as const;
export type EmploymentTypeCode = (typeof EMPLOYMENT_TYPE_CODES)[number];

/** The departments each role family may belong to. Any other combination is malformed. */
export const ROLE_FAMILY_DEPARTMENTS: Readonly<Record<RoleFamilyCode, readonly DepartmentCode[]>> =
  Object.freeze({
    SOFTWARE_ENGINEER: ["ENGINEERING"],
    SRE: ["ENGINEERING"],
    ENGINEERING_MANAGER: ["ENGINEERING"],
    PRODUCT_MANAGER: ["PRODUCT"],
    ACCOUNT_EXECUTIVE: ["SALES"],
  });

export const DepartmentCodeSchema = z.enum(DEPARTMENT_CODES);
export const RoleFamilyCodeSchema = z.enum(ROLE_FAMILY_CODES);
export const EmploymentTypeCodeSchema = z.enum(EMPLOYMENT_TYPE_CODES);

/** Exact-match validation only: no trimming, case folding or fuzzy matching. */
export const employeeFactsShape = {
  departmentCode: DepartmentCodeSchema,
  roleFamilyCode: RoleFamilyCodeSchema,
  employmentType: EmploymentTypeCodeSchema,
};

/** Adds an issue unless the role family belongs to the department. */
export function checkFactCombination(
  facts: { departmentCode: DepartmentCode; roleFamilyCode: RoleFamilyCode },
  ctx: z.RefinementCtx,
): void {
  if (!ROLE_FAMILY_DEPARTMENTS[facts.roleFamilyCode].includes(facts.departmentCode)) {
    ctx.addIssue({
      code: "custom",
      path: ["roleFamilyCode"],
      message: `role family ${facts.roleFamilyCode} is not allowed in department ${facts.departmentCode}`,
    });
  }
}

export const EmployeeFactsSchema = z
  .strictObject(employeeFactsShape)
  .superRefine(checkFactCombination);
export type EmployeeFacts = z.infer<typeof EmployeeFactsSchema>;
