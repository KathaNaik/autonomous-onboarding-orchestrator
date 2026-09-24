import { CatalogError } from "./errors.js";
import { catalogHash } from "./hash.js";
import type { CatalogReference, CatalogResource } from "./schema.js";
import { parseCatalogDocument } from "./validate.js";

/**
 * Immutable input for the future Role Access Agent: the enabled resources of one catalog version,
 * plus the reference the agent's recommendation must carry.
 */
export interface CatalogSnapshot {
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly resources: readonly CatalogResource[];
}

export interface ResourceIdValidation {
  readonly valid: boolean;
  /** Each list is sorted and de-duplicated. */
  readonly unknown: readonly string[];
  readonly disabled: readonly string[];
  readonly duplicates: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One loaded, validated, deeply frozen catalog version. Construction fails as a whole on any
 * invalid data. Iteration order is always by resource id.
 */
export class ResourceCatalog {
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly reference: CatalogReference;
  /** All resources in this version, including disabled ones, sorted by id. */
  readonly resources: readonly CatalogResource[];
  private readonly byId: ReadonlyMap<string, CatalogResource>;
  private readonly enabledSnapshot: CatalogSnapshot;

  constructor(input: unknown) {
    const document = parseCatalogDocument(input);
    this.catalogVersion = document.catalogVersion;
    this.catalogHash = catalogHash(document);
    this.reference = Object.freeze({
      catalogVersion: this.catalogVersion,
      catalogHash: this.catalogHash,
    });
    this.resources = deepFreeze(
      document.resources.map((resource) => ({
        ...structuredClone(resource),
        catalogVersion: document.catalogVersion,
      })),
    );
    this.byId = new Map(this.resources.map((resource) => [resource.resourceId, resource]));
    this.enabledSnapshot = Object.freeze({
      ...this.reference,
      resources: Object.freeze(this.resources.filter((resource) => resource.enabled)),
    });
    Object.freeze(this);
  }

  /** Enabled resources only (the recommendable set), sorted by id. */
  listEnabledResources(): readonly CatalogResource[] {
    return this.enabledSnapshot.resources;
  }

  hasResource(resourceId: string): boolean {
    return this.byId.has(resourceId);
  }

  /** Returns the resource (enabled or not); throws UNKNOWN_RESOURCE for anything not in this version. */
  getResource(resourceId: string): CatalogResource {
    const resource = this.byId.get(resourceId);
    if (!resource) {
      throw new CatalogError(
        "UNKNOWN_RESOURCE",
        `resource "${resourceId}" is not in catalog ${this.catalogVersion}`,
        { resourceIds: [resourceId] },
      );
    }
    return resource;
  }

  /** Reports unknown, disabled and repeated ids. Never throws. */
  validateResourceIds(resourceIds: readonly string[]): ResourceIdValidation {
    const seen = new Set<string>();
    const unknown = new Set<string>();
    const disabled = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of resourceIds) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
      const resource = this.byId.get(id);
      if (!resource) unknown.add(id);
      else if (!resource.enabled) disabled.add(id);
    }
    const sorted = (set: Set<string>) => Object.freeze([...set].sort(compare));
    return Object.freeze({
      valid: unknown.size === 0 && disabled.size === 0 && duplicates.size === 0,
      unknown: sorted(unknown),
      disabled: sorted(disabled),
      duplicates: sorted(duplicates),
    });
  }

  /** Throws UNKNOWN_RESOURCE, then DISABLED_RESOURCE, then DUPLICATE_RESOURCE, naming every offending id. */
  requireValidResourceIds(resourceIds: readonly string[]): void {
    const result = this.validateResourceIds(resourceIds);
    const at = `catalog ${this.catalogVersion}`;
    if (result.unknown.length > 0) {
      throw new CatalogError(
        "UNKNOWN_RESOURCE",
        `unknown resource(s) in ${at}: ${result.unknown.join(", ")}`,
        { resourceIds: result.unknown },
      );
    }
    if (result.disabled.length > 0) {
      throw new CatalogError(
        "DISABLED_RESOURCE",
        `disabled resource(s) in ${at}: ${result.disabled.join(", ")}`,
        { resourceIds: result.disabled },
      );
    }
    if (result.duplicates.length > 0) {
      throw new CatalogError(
        "DUPLICATE_RESOURCE",
        `resource(s) listed more than once: ${result.duplicates.join(", ")}`,
        { resourceIds: result.duplicates },
      );
    }
  }

  /**
   * The requested resources plus all their transitive dependencies, in provisioning order: every
   * resource comes after everything it depends on; ties are broken by id, so the order is
   * deterministic. Invalid input throws (see requireValidResourceIds).
   */
  resolveDependencyOrder(resourceIds: readonly string[]): readonly string[] {
    this.requireValidResourceIds(resourceIds);

    const closure = new Set<string>();
    const collect = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      for (const dependency of this.getResource(id).dependsOn) collect(dependency);
    };
    resourceIds.forEach(collect);

    // Kahn's algorithm over the closure, always taking the smallest ready id.
    const remaining = new Map(
      [...closure].map((id) => [id, new Set(this.getResource(id).dependsOn)] as const),
    );
    const order: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      const next = ready.sort(compare)[0];
      // Unreachable: load-time validation rejects cycles.
      if (next === undefined) throw new Error("dependency cycle in a validated catalog");
      order.push(next);
      remaining.delete(next);
      for (const deps of remaining.values()) deps.delete(next);
    }
    return Object.freeze(order);
  }

  /** The frozen agent input for this version. The same object is returned on every call. */
  snapshot(): CatalogSnapshot {
    return this.enabledSnapshot;
  }

  /** Throws CATALOG_VERSION_MISMATCH unless the reference names exactly this catalog content. */
  assertReference(reference: CatalogReference): void {
    if (
      reference.catalogVersion !== this.catalogVersion ||
      reference.catalogHash !== this.catalogHash
    ) {
      throw new CatalogError(
        "CATALOG_VERSION_MISMATCH",
        `reference ${reference.catalogVersion} (${reference.catalogHash}) does not match catalog ` +
          `${this.catalogVersion} (${this.catalogHash})`,
      );
    }
  }
}
