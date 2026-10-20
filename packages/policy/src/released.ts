import { loadCatalogRegistry, type CatalogRegistry } from "@aoo/catalog";
import { DEPARTMENT_CODES, EMPLOYMENT_TYPE_CODES, ROLE_FAMILY_CODES } from "@aoo/shared";
import { PolicyRegistry, type PolicyRelease } from "./registry.js";
import v1_0_0 from "./releases/1.0.0.json" with { type: "json" };
import v1_1_0 from "./releases/1.1.0.json" with { type: "json" };
import v1_2_0 from "./releases/1.2.0.json" with { type: "json" };

/**
 * Every released policy version with the content hash it was released with. Append only:
 * never edit a released file or its hash. To change the policy, add src/releases/<next>.json,
 * add it here with its hash (the load error prints the computed one), and bump
 * CURRENT_POLICY_VERSION.
 */
export const POLICY_RELEASES: readonly PolicyRelease[] = Object.freeze([
  {
    document: v1_0_0,
    policyHash: "sha256:b6b9aac1fb7b8c46af96cde4af0cde19c53cd0f1eca511de713e41a1d83650f4",
  },
  {
    // M5C: re-keyed to the canonical HRIS facts (SRE, no INTERN). Rules otherwise unchanged.
    document: v1_1_0,
    policyHash: "sha256:3e9e780460d6a8563071040c8f7f6e86b33e3ee262953828e445ecebf44cbf9e",
  },
  {
    // M14: the same rules, re-bound to catalog 1.1.0 (Slack and AWS development via Okta).
    document: v1_2_0,
    policyHash: "sha256:3949d55754c4ac7a01197141dea65396346606a4c5cd99e043bd2ad7248fc470",
  },
]);

/** The version new decisions use. It must be bound to the current catalog release. */
export const CURRENT_POLICY_VERSION = "1.2.0";

/**
 * Loads and verifies every released policy against the released catalogs, and checks that the
 * current policy uses exactly the canonical employee-fact values from `@aoo/shared`.
 */
export function loadPolicyRegistry(
  catalogs: CatalogRegistry = loadCatalogRegistry(),
): PolicyRegistry {
  return new PolicyRegistry({
    releases: POLICY_RELEASES,
    currentVersion: CURRENT_POLICY_VERSION,
    catalogs,
    canonicalFacts: {
      departments: DEPARTMENT_CODES,
      roleFamilies: ROLE_FAMILY_CODES,
      employmentTypes: EMPLOYMENT_TYPE_CODES,
    },
  });
}
