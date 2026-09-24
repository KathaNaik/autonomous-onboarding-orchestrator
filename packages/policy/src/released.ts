import { loadCatalogRegistry, type CatalogRegistry } from "@aoo/catalog";
import { PolicyRegistry, type PolicyRelease } from "./registry.js";
import v1_0_0 from "./releases/1.0.0.json" with { type: "json" };

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
]);

/** The version new decisions use. It must be bound to the current catalog release. */
export const CURRENT_POLICY_VERSION = "1.0.0";

/** Loads and verifies every released policy against the released catalogs. */
export function loadPolicyRegistry(
  catalogs: CatalogRegistry = loadCatalogRegistry(),
): PolicyRegistry {
  return new PolicyRegistry({
    releases: POLICY_RELEASES,
    currentVersion: CURRENT_POLICY_VERSION,
    catalogs,
  });
}
