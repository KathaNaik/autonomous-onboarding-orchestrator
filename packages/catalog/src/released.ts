import v1_0_0 from "./versions/1.0.0.json" with { type: "json" };
import { CatalogRegistry, type CatalogRelease } from "./registry.js";

/**
 * Every released catalog version with the content hash it was released with. Append only:
 * never edit a released file or its hash. To change the catalog, add src/versions/<next>.json,
 * add it here with its hash (the load error prints the computed one), and bump
 * CURRENT_CATALOG_VERSION.
 */
export const CATALOG_RELEASES: readonly CatalogRelease[] = Object.freeze([
  {
    document: v1_0_0,
    catalogHash: "sha256:e918abe116e7fd51716f9366133a60e015a4e688c99f96e6aef8cbc2493fa776",
  },
]);

/** The version new recommendations use. */
export const CURRENT_CATALOG_VERSION = "1.0.0";

/** Loads and verifies every released version. Throws on any invalid or modified release. */
export function loadCatalogRegistry(): CatalogRegistry {
  return new CatalogRegistry({
    releases: CATALOG_RELEASES,
    currentVersion: CURRENT_CATALOG_VERSION,
  });
}
