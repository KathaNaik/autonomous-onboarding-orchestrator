import { CatalogError } from "./errors.js";
import {
  CatalogDocumentSchema,
  type CatalogDocument,
  type CatalogResourceDefinition,
} from "./schema.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validates a catalog document completely, or throws INVALID_CATALOG listing every issue.
 * Returns it normalized: resources sorted by id and each dependsOn sorted, so the file order
 * never changes the catalog's meaning, hash or iteration order.
 */
export function parseCatalogDocument(input: unknown): CatalogDocument {
  const parsed = CatalogDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    );
    throw invalid(issues);
  }
  const document: CatalogDocument = {
    catalogVersion: parsed.data.catalogVersion,
    resources: parsed.data.resources
      .map((resource) => ({ ...resource, dependsOn: [...resource.dependsOn].sort(compare) }))
      .sort((a, b) => compare(a.resourceId, b.resourceId)),
  };
  const issues = graphIssues(document.resources);
  if (issues.length > 0) throw invalid(issues, document.catalogVersion);
  return document;
}

function invalid(issues: string[], version?: string): CatalogError {
  const label = version ? `catalog ${version}` : "catalog";
  return new CatalogError(
    "INVALID_CATALOG",
    `${label} is invalid (${issues.length} issue(s)): ${issues.join("; ")}`,
    { issues },
  );
}

function graphIssues(resources: readonly CatalogResourceDefinition[]): string[] {
  const issues: string[] = [];
  const byId = new Map<string, CatalogResourceDefinition>();
  for (const resource of resources) {
    if (byId.has(resource.resourceId)) {
      issues.push(`duplicate resource id "${resource.resourceId}"`);
    } else {
      byId.set(resource.resourceId, resource);
    }
  }

  for (const resource of resources) {
    const seen = new Set<string>();
    for (const dependency of resource.dependsOn) {
      const at = `resource "${resource.resourceId}"`;
      if (seen.has(dependency)) issues.push(`${at} lists dependency "${dependency}" twice`);
      seen.add(dependency);
      if (dependency === resource.resourceId) {
        issues.push(`${at} depends on itself`);
        continue;
      }
      const target = byId.get(dependency);
      if (!target) {
        issues.push(`${at} depends on unknown resource "${dependency}"`);
      } else if (resource.enabled && !target.enabled) {
        // It could never be provisioned, so it must not be recommendable.
        issues.push(`enabled ${at} depends on disabled resource "${dependency}"`);
      }
    }
  }

  // Cycle detection (self-dependencies are reported above). Iterative order is by id, so the
  // reported cycles are deterministic.
  const state = new Map<string, "visiting" | "done">();
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (dependency === id || !byId.has(dependency)) continue;
      const status = state.get(dependency);
      if (status === "visiting") {
        const cycle = [...path.slice(path.indexOf(dependency)), dependency];
        const key = [...new Set(cycle)].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          issues.push(`dependency cycle: ${cycle.join(" -> ")}`);
        }
      } else if (status === undefined) {
        visit(dependency, [...path, dependency]);
      }
    }
    state.set(id, "done");
  };
  for (const id of [...byId.keys()].sort(compare)) {
    if (!state.has(id)) visit(id, [id]);
  }
  return issues;
}
