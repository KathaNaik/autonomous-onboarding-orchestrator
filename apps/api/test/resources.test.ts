import { CURRENT_CATALOG_VERSION, loadCatalogRegistry } from "@aoo/catalog";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

describe("resource catalog routes", () => {
  let app: FastifyInstance;
  const catalog = loadCatalogRegistry().current;

  beforeAll(async () => {
    app = await buildApp(testConfig());
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /resources lists enabled resources of the current version, sorted", async () => {
    const res = await app.inject({ method: "GET", url: "/resources" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalogVersion).toBe(CURRENT_CATALOG_VERSION);
    expect(body.catalogHash).toBe(catalog.catalogHash);
    const ids = body.resources.map((r: { resourceId: string }) => r.resourceId);
    expect(ids).toEqual(catalog.listEnabledResources().map((r) => r.resourceId));
    expect(ids).not.toContain("aws-staging");
    expect(ids).toEqual([...ids].sort());
  });

  it("GET /resources/:id returns one resource, including disabled ones", async () => {
    const res = await app.inject({ method: "GET", url: "/resources/github-team-backend" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      catalogVersion: CURRENT_CATALOG_VERSION,
      resource: { resourceId: "github-team-backend", dependsOn: ["github-org-membership"] },
    });
    const disabled = await app.inject({ method: "GET", url: "/resources/aws-staging" });
    expect(disabled.json().resource.enabled).toBe(false);
  });

  it("returns 404 for unknown and 400 for malformed ids", async () => {
    const unknown = await app.inject({ method: "GET", url: "/resources/github-enterprise-admin" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("UNKNOWN_RESOURCE");
    const malformed = await app.inject({ method: "GET", url: "/resources/Not_An_Id" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("INVALID_RESOURCE_ID");
  });

  it("exposes no write methods", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/resources/aws-dev" });
      expect(res.statusCode).toBe(404);
    }
  });
});
