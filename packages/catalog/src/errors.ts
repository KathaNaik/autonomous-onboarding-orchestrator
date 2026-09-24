export type CatalogErrorCode =
  /** Catalog data failed validation. Nothing is loaded: there are no partial catalogs. */
  | "INVALID_CATALOG"
  | "UNKNOWN_RESOURCE"
  | "DISABLED_RESOURCE"
  | "DUPLICATE_RESOURCE"
  | "UNKNOWN_CATALOG_VERSION"
  /** A recorded {catalogVersion, catalogHash} doesn't match the catalog it is checked against. */
  | "CATALOG_VERSION_MISMATCH";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  /** Offending resource ids (sorted) for resource errors; empty otherwise. */
  readonly resourceIds: readonly string[];
  /** Every problem found, for INVALID_CATALOG. */
  readonly issues: readonly string[];

  constructor(
    code: CatalogErrorCode,
    message: string,
    options: { resourceIds?: readonly string[]; issues?: readonly string[] } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.resourceIds = Object.freeze([...(options.resourceIds ?? [])].sort());
    this.issues = Object.freeze([...(options.issues ?? [])]);
  }
}
