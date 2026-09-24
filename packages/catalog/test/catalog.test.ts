import { describe, expect, it } from "vitest";
import { CatalogError, ResourceCatalog, type CatalogErrorCode } from "../src/index.js";
import { catalogDocument, resource } from "./helpers.js";

function catalogError(fn: () => unknown): CatalogError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CatalogError) return err;
    throw err;
  }
  throw new Error("expected a CatalogError");
}

function expectInvalid(document: unknown, ...fragments: string[]) {
  const err = catalogError(() => new ResourceCatalog(document));
  expect(err.code).toBe<CatalogErrorCode>("INVALID_CATALOG");
  for (const fragment of fragments) {
    expect(err.issues.some((issue) => issue.includes(fragment))).toBe(true);
  }
  return err;
}

/** A small graph: app -> (team -> org), db -> org. */
const graph = () =>
  catalogDocument([
    resource("org"),
    resource("team", { dependsOn: ["org"] }),
    resource("app", { dependsOn: ["team", "db"] }),
    resource("db", { dependsOn: ["org"] }),
    resource("legacy", { enabled: false, dependsOn: ["org"] }),
    resource("standalone"),
  ]);

describe("loading", () => {
  it("loads a valid catalog and stamps each resource with its version", () => {
    const catalog = new ResourceCatalog(graph());
    expect(catalog.catalogVersion).toBe("1.0.0");
    expect(catalog.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(catalog.reference).toEqual({
      catalogVersion: "1.0.0",
      catalogHash: catalog.catalogHash,
    });
    expect(catalog.resources).toHaveLength(6);
    expect(catalog.resources.every((r) => r.catalogVersion === "1.0.0")).toBe(true);
  });

  it("rejects duplicate resource ids", () => {
    expectInvalid(
      catalogDocument([resource("a"), resource("b"), resource("a")]),
      'duplicate resource id "a"',
    );
  });

  it("rejects dependencies on missing resources", () => {
    expectInvalid(
      catalogDocument([resource("a", { dependsOn: ["ghost"] })]),
      'resource "a" depends on unknown resource "ghost"',
    );
  });

  it("rejects self-dependencies", () => {
    expectInvalid(
      catalogDocument([resource("a", { dependsOn: ["a"] })]),
      'resource "a" depends on itself',
    );
  });

  it("rejects dependency cycles, direct and indirect", () => {
    expectInvalid(
      catalogDocument([resource("a", { dependsOn: ["b"] }), resource("b", { dependsOn: ["a"] })]),
      "dependency cycle: a -> b -> a",
    );
    expectInvalid(
      catalogDocument([
        resource("a", { dependsOn: ["b"] }),
        resource("b", { dependsOn: ["c"] }),
        resource("c", { dependsOn: ["a"] }),
        resource("d", { dependsOn: ["a"] }),
      ]),
      "dependency cycle: a -> b -> c -> a",
    );
  });

  it("rejects an enabled resource that depends on a disabled one", () => {
    expectInvalid(
      catalogDocument([
        resource("off", { enabled: false }),
        resource("on", { dependsOn: ["off"] }),
      ]),
      'enabled resource "on" depends on disabled resource "off"',
    );
  });

  it("rejects a dependency listed twice", () => {
    expectInvalid(
      catalogDocument([resource("a"), resource("b", { dependsOn: ["a", "a"] })]),
      'lists dependency "a" twice',
    );
  });

  it("reports every problem at once and loads nothing", () => {
    const err = expectInvalid(
      catalogDocument([
        resource("a", { dependsOn: ["a"] }),
        resource("b", { dependsOn: ["missing"] }),
        resource("b"),
      ]),
    );
    expect(err.issues).toHaveLength(3);
  });

  it.each([
    ["catalog version format", { catalogVersion: "v1" }, "catalogVersion"],
    ["catalog version with leading zero", { catalogVersion: "1.02.0" }, "catalogVersion"],
    ["empty catalog", { resources: [] }, "resources"],
    ["unknown top-level key", { extra: true }, "(root)"],
  ])("rejects an invalid document: %s", (_label, patch, path) => {
    expectInvalid({ ...catalogDocument([resource("a")]), ...patch }, path);
  });

  it.each([
    ["provider", { provider: "AZURE_AD" }],
    ["category", { category: "SNACKS" }],
    ["environment", { environment: "QA" }],
    ["risk level", { riskLevel: "EXTREME" }],
    ["enabled flag", { enabled: "yes" }],
    ["resource id format", { resourceId: "Not_Kebab" }],
    ["dependency id format", { dependsOn: ["UPPER"] }],
    ["unknown resource key", { owner: "someone" }],
    ["metadata for another provider", { provider: "GITHUB", providerMetadata: { groupName: "x" } }],
    ["missing provider metadata", { provider: "OKTA", providerMetadata: {} }],
  ])("rejects an invalid resource: %s", (_label, patch) => {
    expectInvalid(catalogDocument([{ ...resource("a"), ...patch } as never]), "resources.0");
  });

  it("accepts every provider with its own metadata", () => {
    const catalog = new ResourceCatalog(
      catalogDocument([
        { ...resource("sn"), provider: "SERVICENOW", providerMetadata: { assignmentGroup: "G" } },
        { ...resource("okta"), provider: "OKTA", providerMetadata: { groupName: "Eng" } },
        {
          ...resource("gh"),
          provider: "GITHUB",
          providerMetadata: { organization: "acme", team: null },
        },
        {
          ...resource("manual"),
          provider: "MANUAL",
          providerMetadata: { fulfillmentTeam: "IT", instructions: "Do it." },
        },
        resource("none"),
      ]),
    );
    // Sorted by id: gh, manual, none, okta, sn.
    expect(catalog.resources.map((r) => r.provider)).toEqual([
      "GITHUB",
      "MANUAL",
      "NONE",
      "OKTA",
      "SERVICENOW",
    ]);
  });
});

describe("lookup", () => {
  const catalog = new ResourceCatalog(graph());

  it("gets a resource by id", () => {
    expect(catalog.getResource("team").dependsOn).toEqual(["org"]);
  });

  it("fails explicitly for unknown resource ids", () => {
    const err = catalogError(() => catalog.getResource("github-enterprise-admin"));
    expect(err.code).toBe("UNKNOWN_RESOURCE");
    expect(err.resourceIds).toEqual(["github-enterprise-admin"]);
    expect(catalog.hasResource("github-enterprise-admin")).toBe(false);
  });

  it("keeps disabled resources readable but out of the enabled list", () => {
    expect(catalog.getResource("legacy").enabled).toBe(false);
    expect(catalog.listEnabledResources().map((r) => r.resourceId)).toEqual([
      "app",
      "db",
      "org",
      "standalone",
      "team",
    ]);
  });
});

describe("validateResourceIds", () => {
  const catalog = new ResourceCatalog(graph());

  it("accepts known, enabled, distinct ids", () => {
    expect(catalog.validateResourceIds(["team", "org"])).toEqual({
      valid: true,
      unknown: [],
      disabled: [],
      duplicates: [],
    });
  });

  it("reports unknown, disabled and repeated ids, sorted", () => {
    expect(catalog.validateResourceIds(["zeta", "legacy", "org", "alpha", "org"])).toEqual({
      valid: false,
      unknown: ["alpha", "zeta"],
      disabled: ["legacy"],
      duplicates: ["org"],
    });
  });

  it("throws with a specific code from requireValidResourceIds", () => {
    expect(catalogError(() => catalog.requireValidResourceIds(["nope", "legacy"])).code).toBe(
      "UNKNOWN_RESOURCE",
    );
    const disabled = catalogError(() => catalog.requireValidResourceIds(["legacy"]));
    expect(disabled.code).toBe("DISABLED_RESOURCE");
    expect(disabled.resourceIds).toEqual(["legacy"]);
    expect(catalogError(() => catalog.requireValidResourceIds(["org", "org"])).code).toBe(
      "DUPLICATE_RESOURCE",
    );
    expect(() => catalog.requireValidResourceIds([])).not.toThrow();
  });
});

describe("resolveDependencyOrder", () => {
  const catalog = new ResourceCatalog(graph());

  it("adds transitive dependencies and orders dependencies first", () => {
    expect(catalog.resolveDependencyOrder(["app"])).toEqual(["org", "db", "team", "app"]);
  });

  it("is deterministic regardless of request order", () => {
    const expected = ["org", "db", "standalone", "team", "app"];
    expect(catalog.resolveDependencyOrder(["app", "standalone"])).toEqual(expected);
    expect(catalog.resolveDependencyOrder(["standalone", "team", "app", "org"])).toEqual(expected);
  });

  it("returns an empty order for an empty request", () => {
    expect(catalog.resolveDependencyOrder([])).toEqual([]);
  });

  it("rejects unknown and disabled resources", () => {
    expect(catalogError(() => catalog.resolveDependencyOrder(["app", "ghost"])).code).toBe(
      "UNKNOWN_RESOURCE",
    );
    expect(catalogError(() => catalog.resolveDependencyOrder(["legacy"])).code).toBe(
      "DISABLED_RESOURCE",
    );
  });
});

describe("determinism", () => {
  it("orders resources and dependencies by id, whatever the file order", () => {
    const shuffled = catalogDocument([
      resource("zeta", { dependsOn: ["beta", "alpha"] }),
      resource("alpha"),
      resource("beta"),
    ]);
    const catalog = new ResourceCatalog(shuffled);
    expect(catalog.resources.map((r) => r.resourceId)).toEqual(["alpha", "beta", "zeta"]);
    expect(catalog.getResource("zeta").dependsOn).toEqual(["alpha", "beta"]);
  });

  it("hashes content, not file order or key order", () => {
    const a = new ResourceCatalog(graph());
    const reordered = graph();
    reordered.resources.reverse();
    const b = new ResourceCatalog(reordered);
    const keysReversed = {
      resources: reordered.resources.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      catalogVersion: "1.0.0",
    };
    expect(b.catalogHash).toBe(a.catalogHash);
    expect(new ResourceCatalog(keysReversed).catalogHash).toBe(a.catalogHash);
  });

  it("changes the hash when any content changes", () => {
    const base = new ResourceCatalog(graph()).catalogHash;
    const edited = graph();
    edited.resources[0] = { ...edited.resources[0]!, riskLevel: "HIGH" };
    expect(new ResourceCatalog(edited).catalogHash).not.toBe(base);
    const disabled = graph();
    disabled.resources[5] = { ...disabled.resources[5]!, enabled: false };
    expect(new ResourceCatalog(disabled).catalogHash).not.toBe(base);
  });
});

describe("immutable snapshots", () => {
  it("exposes a deeply frozen snapshot of enabled resources", () => {
    const catalog = new ResourceCatalog(graph());
    const snapshot = catalog.snapshot();
    expect(snapshot.catalogVersion).toBe("1.0.0");
    expect(snapshot.catalogHash).toBe(catalog.catalogHash);
    expect(snapshot.resources.map((r) => r.resourceId)).not.toContain("legacy");
    expect(catalog.snapshot()).toBe(snapshot);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
    const team = snapshot.resources.find((r) => r.resourceId === "team")!;
    expect(Object.isFrozen(team)).toBe(true);
    expect(Object.isFrozen(team.dependsOn)).toBe(true);
    expect(Object.isFrozen(team.providerMetadata)).toBe(true);
    expect(() => {
      (team as { enabled: boolean }).enabled = false;
    }).toThrow(TypeError);
    expect(() => (snapshot.resources as unknown[]).push({})).toThrow(TypeError);
    expect(() => (team.dependsOn as string[]).push("db")).toThrow(TypeError);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("is not affected by later changes to the input document", () => {
    const input = graph();
    const catalog = new ResourceCatalog(input);
    input.resources[0]!.dependsOn.push("standalone");
    input.resources[0]!.enabled = false;
    input.catalogVersion = "9.9.9";
    expect(catalog.catalogVersion).toBe("1.0.0");
    expect(catalog.getResource("org").dependsOn).toEqual([]);
    expect(catalog.getResource("org").enabled).toBe(true);
  });
});

describe("assertReference", () => {
  const catalog = new ResourceCatalog(graph());

  it("accepts its own reference", () => {
    expect(() => catalog.assertReference(catalog.reference)).not.toThrow();
  });

  it("rejects another version or another hash", () => {
    const wrongVersion = { ...catalog.reference, catalogVersion: "1.0.1" };
    const wrongHash = { ...catalog.reference, catalogHash: `sha256:${"0".repeat(64)}` };
    expect(catalogError(() => catalog.assertReference(wrongVersion)).code).toBe(
      "CATALOG_VERSION_MISMATCH",
    );
    expect(catalogError(() => catalog.assertReference(wrongHash)).code).toBe(
      "CATALOG_VERSION_MISMATCH",
    );
  });
});
