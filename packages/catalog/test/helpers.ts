import type { CatalogDocument, CatalogResourceDefinition } from "../src/index.js";

type Overrides = Partial<Omit<CatalogResourceDefinition, "provider" | "providerMetadata">>;

/** A minimal valid resource (provider NONE) with the given id. */
export function resource(resourceId: string, overrides: Overrides = {}): CatalogResourceDefinition {
  return {
    resourceId,
    displayName: `Resource ${resourceId}`,
    description: `Test resource ${resourceId}.`,
    category: "DEVELOPER_TOOLS",
    environment: null,
    enabled: true,
    dependsOn: [],
    riskLevel: "LOW",
    provider: "NONE",
    providerMetadata: {},
    ...overrides,
  };
}

export function catalogDocument(
  resources: CatalogResourceDefinition[],
  catalogVersion = "1.0.0",
): CatalogDocument {
  return { catalogVersion, resources };
}
