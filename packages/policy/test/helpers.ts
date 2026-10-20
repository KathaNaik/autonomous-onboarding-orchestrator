import { loadCatalogRegistry } from "@aoo/catalog";
import {
  PolicyEngine,
  PolicyError,
  type PolicyDocument,
  type PolicyRule,
  type PolicySubject,
} from "../src/index.js";

export const catalogs = loadCatalogRegistry();
export const catalogRef = catalogs.current.reference;
/** Catalog 1.0.0, which the released policies 1.0.0 and 1.1.0 are bound to. */
export const catalogRefV1 = catalogs.get("1.0.0").reference;

export function subject(overrides: Partial<PolicySubject> = {}): PolicySubject {
  return {
    employeeId: "TEST-EMP-0001",
    department: "ENGINEERING",
    roleFamily: "SOFTWARE_ENGINEER",
    employmentType: "FULL_TIME",
    ...overrides,
  };
}

export function rule(ruleId: string, overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    ruleId,
    decision: "ALLOW",
    reasonCode: "TEST_REASON",
    explanation: `Test rule ${ruleId}.`,
    when: { departments: ["ENGINEERING"], resourceIds: ["github-org-membership"] },
    ...overrides,
  };
}

/** A small valid policy bound to the released catalog. */
export function policyDocument(
  rules: PolicyRule[] = [rule("baseline")],
  policyVersion = "1.0.0",
): PolicyDocument {
  return {
    policyVersion,
    catalog: { ...catalogRef },
    subjectAttributes: {
      departments: ["ENGINEERING", "SALES"],
      roleFamilies: ["SOFTWARE_ENGINEER", "ACCOUNT_EXECUTIVE"],
    },
    rules,
  };
}

export function policyError(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PolicyError) return err;
    throw err;
  }
  throw new Error("expected a PolicyError");
}

/** Loads the document and returns the INVALID_POLICY issues. */
export function loadIssues(document: unknown): readonly string[] {
  const err = policyError(() => new PolicyEngine(document, catalogs));
  if (err.code !== "INVALID_POLICY") throw new Error(`expected INVALID_POLICY, got ${err.code}`);
  return err.issues;
}
