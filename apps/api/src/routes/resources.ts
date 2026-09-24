import { RESOURCE_ID_PATTERN, type CatalogResource, type ResourceCatalog } from "@aoo/catalog";
import type { FastifyPluginAsync } from "fastify";

export interface ResourceRoutesOptions {
  catalog: ResourceCatalog;
}

export interface ResourceListResponse {
  catalogVersion: string;
  catalogHash: string;
  resources: readonly CatalogResource[];
}

export interface ResourceResponse {
  catalogVersion: string;
  catalogHash: string;
  resource: CatalogResource;
}

export interface ResourceErrorResponse {
  error: "UNKNOWN_RESOURCE" | "INVALID_RESOURCE_ID";
  message: string;
}

/** Read-only view of the current catalog version. No writes: the catalog is released in code. */
export const resourceRoutes: FastifyPluginAsync<ResourceRoutesOptions> = async (
  app,
  { catalog },
) => {
  app.get("/resources", async (): Promise<ResourceListResponse> => ({
    ...catalog.reference,
    resources: catalog.listEnabledResources(),
  }));

  app.get<{ Params: { resourceId: string } }>("/resources/:resourceId", async (request, reply) => {
    const { resourceId } = request.params;
    if (resourceId.length > 64 || !RESOURCE_ID_PATTERN.test(resourceId)) {
      const body: ResourceErrorResponse = {
        error: "INVALID_RESOURCE_ID",
        message: "resource id must be lowercase kebab-case",
      };
      return reply.code(400).send(body);
    }
    if (!catalog.hasResource(resourceId)) {
      const body: ResourceErrorResponse = {
        error: "UNKNOWN_RESOURCE",
        message: `resource "${resourceId}" is not in catalog ${catalog.catalogVersion}`,
      };
      return reply.code(404).send(body);
    }
    // Disabled resources are returned too (enabled: false), so old references stay explainable.
    const body: ResourceResponse = {
      ...catalog.reference,
      resource: catalog.getResource(resourceId),
    };
    return body;
  });
};
