import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_RELEASES,
  CatalogError,
  CatalogRegistry,
  CURRENT_CATALOG_VERSION,
  ResourceCatalog,
  loadCatalogRegistry,
} from "../src/index.js";
import { catalogDocument, resource } from "./helpers.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CatalogError) return err.code;
    throw err;
  }
  throw new Error("expected a CatalogError");
}

const v1 = catalogDocument([resource("org"), resource("team", { dependsOn: ["org"] })], "1.0.0");
// 1.1.0 changes the meaning of "team": it now also needs "sso".
const v1_1 = catalogDocument(
  [resource("org"), resource("sso"), resource("team", { dependsOn: ["org", "sso"] })],
  "1.1.0",
);
const release = (document: unknown) => ({
  document,
  catalogHash: new ResourceCatalog(document).catalogHash,
});

describe("CatalogRegistry", () => {
  const registry = new CatalogRegistry({
    releases: [release(v1_1), release(v1)],
    currentVersion: "1.1.0",
  });

  it("serves every released version, sorted, with a current version", () => {
    expect(registry.versions).toEqual(["1.0.0", "1.1.0"]);
    expect(registry.current.catalogVersion).toBe("1.1.0");
  });

  it("resolves a recorded reference to exactly the catalog it was made with", () => {
    const recordedOnV1 = registry.get("1.0.0").reference;
    const catalog = registry.resolve(recordedOnV1);
    // A newer release doesn't change what the old recommendation meant.
    expect(catalog.resolveDependencyOrder(["team"])).toEqual(["org", "team"]);
    expect(registry.current.resolveDependencyOrder(["team"])).toEqual(["org", "sso", "team"]);
  });

  it("rejects unknown versions and hash mismatches", () => {
    expect(codeOf(() => registry.get("2.0.0"))).toBe("UNKNOWN_CATALOG_VERSION");
    expect(
      codeOf(() =>
        registry.resolve({ catalogVersion: "2.0.0", catalogHash: `sha256:${"a".repeat(64)}` }),
      ),
    ).toBe("UNKNOWN_CATALOG_VERSION");
    // Right version, but content from another version: never silently accepted.
    expect(
      codeOf(() =>
        registry.resolve({
          catalogVersion: "1.0.0",
          catalogHash: registry.get("1.1.0").catalogHash,
        }),
      ),
    ).toBe("CATALOG_VERSION_MISMATCH");
    expect(codeOf(() => registry.resolve({ catalogVersion: "1.0.0" } as never))).toBe(
      "CATALOG_VERSION_MISMATCH",
    );
  });

  it("refuses a released version whose content no longer matches its pinned hash", () => {
    const pinned = release(v1);
    const edited = catalogDocument(
      [resource("org"), resource("team", { dependsOn: ["org"], riskLevel: "HIGH" })],
      "1.0.0",
    );
    const err = (() => {
      try {
        new CatalogRegistry({
          releases: [{ document: edited, catalogHash: pinned.catalogHash }],
          currentVersion: "1.0.0",
        });
      } catch (e) {
        return e as CatalogError;
      }
      throw new Error("expected failure");
    })();
    expect(err.code).toBe("INVALID_CATALOG");
    expect(err.message).toContain("Released versions are immutable");
  });

  it("refuses duplicate releases, an unreleased current version and invalid releases", () => {
    expect(
      codeOf(
        () =>
          new CatalogRegistry({ releases: [release(v1), release(v1)], currentVersion: "1.0.0" }),
      ),
    ).toBe("INVALID_CATALOG");
    expect(
      codeOf(() => new CatalogRegistry({ releases: [release(v1)], currentVersion: "1.1.0" })),
    ).toBe("INVALID_CATALOG");
    const broken = catalogDocument([resource("a", { dependsOn: ["a"] })], "1.2.0");
    expect(
      codeOf(
        () =>
          new CatalogRegistry({
            releases: [release(v1), { document: broken, catalogHash: `sha256:${"0".repeat(64)}` }],
            currentVersion: "1.0.0",
          }),
      ),
    ).toBe("INVALID_CATALOG");
  });
});

describe("released seed catalog", () => {
  const registry = loadCatalogRegistry();
  const catalog = registry.current;

  it("loads and matches its pinned hash", () => {
    expect(catalog.catalogVersion).toBe(CURRENT_CATALOG_VERSION);
    expect(registry.versions).toEqual(["1.0.0"]);
    expect(catalog.resources).toHaveLength(10);
    expect(catalog.listEnabledResources()).toHaveLength(9);
  });

  it("ships exactly the released version files", () => {
    const files = readdirSync(new URL("../src/versions/", import.meta.url)).sort();
    const released = CATALOG_RELEASES.map(
      (r) => `${(r.document as { catalogVersion: string }).catalogVersion}.json`,
    ).sort();
    expect(files).toEqual(released);
  });

  it("declares dependencies per resource, with no universal root", () => {
    expect(catalog.resolveDependencyOrder(["github-team-backend", "aws-prod"])).toEqual([
      "aws-dev",
      "aws-prod",
      "github-org-membership",
      "github-team-backend",
    ]);
    const roots = catalog.listEnabledResources().filter((r) => r.dependsOn.length === 0);
    expect(roots.length).toBeGreaterThan(1);
    expect(catalog.resources.some((r) => r.dependsOn.includes("okta-engineering-group"))).toBe(
      false,
    );
  });
});
