import { ResourceCatalog } from "./catalog.js";
import { CatalogError } from "./errors.js";
import { CatalogReferenceSchema, CatalogVersionSchema, type CatalogReference } from "./schema.js";

/** A released catalog version and the content hash it was released with. */
export interface CatalogRelease {
  readonly document: unknown;
  readonly catalogHash: string;
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Every released catalog version, loaded and verified at once. */
export class CatalogRegistry {
  /** The version new recommendations use. */
  readonly current: ResourceCatalog;
  /** Released versions, ascending. */
  readonly versions: readonly string[];
  private readonly byVersion: ReadonlyMap<string, ResourceCatalog>;

  /**
   * Fails as a whole (INVALID_CATALOG) if any release is invalid, a version is released twice,
   * the current version isn't released, or a released document no longer matches its pinned
   * hash, i.e. someone edited a released version instead of releasing a new one.
   */
  constructor(options: { releases: readonly CatalogRelease[]; currentVersion: string }) {
    const catalogs = new Map<string, ResourceCatalog>();
    for (const release of options.releases) {
      const catalog = new ResourceCatalog(release.document);
      const version = catalog.catalogVersion;
      if (catalogs.has(version)) {
        throw new CatalogError("INVALID_CATALOG", `catalog ${version} is released twice`);
      }
      if (catalog.catalogHash !== release.catalogHash) {
        throw new CatalogError(
          "INVALID_CATALOG",
          `catalog ${version} does not match its pinned hash (pinned ${release.catalogHash}, ` +
            `content ${catalog.catalogHash}). Released versions are immutable: release a new ` +
            `version instead of editing this one.`,
        );
      }
      catalogs.set(version, catalog);
    }
    const currentVersion = CatalogVersionSchema.parse(options.currentVersion);
    const current = catalogs.get(currentVersion);
    if (!current) {
      throw new CatalogError(
        "INVALID_CATALOG",
        `current catalog version ${currentVersion} is not released`,
      );
    }
    this.current = current;
    this.versions = Object.freeze([...catalogs.keys()].sort(compareVersions));
    this.byVersion = catalogs;
    Object.freeze(this);
  }

  /** Throws UNKNOWN_CATALOG_VERSION for versions that were never released. */
  get(catalogVersion: string): ResourceCatalog {
    const catalog = this.byVersion.get(catalogVersion);
    if (!catalog) {
      throw new CatalogError(
        "UNKNOWN_CATALOG_VERSION",
        `catalog version ${catalogVersion} is not released (released: ${this.versions.join(", ")})`,
      );
    }
    return catalog;
  }

  /**
   * The exact catalog a recorded recommendation used. Throws UNKNOWN_CATALOG_VERSION, or
   * CATALOG_VERSION_MISMATCH when the recorded hash differs from that version's content.
   */
  resolve(reference: CatalogReference): ResourceCatalog {
    const parsed = CatalogReferenceSchema.safeParse(reference);
    if (!parsed.success) {
      throw new CatalogError("CATALOG_VERSION_MISMATCH", "malformed catalog reference");
    }
    const catalog = this.get(parsed.data.catalogVersion);
    catalog.assertReference(parsed.data);
    return catalog;
  }
}
