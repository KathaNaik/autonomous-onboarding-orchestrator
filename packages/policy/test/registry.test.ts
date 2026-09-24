import { readdirSync } from "node:fs";
import { CATALOG_RELEASES, CatalogRegistry, ResourceCatalog } from "@aoo/catalog";
import { describe, expect, it } from "vitest";
import { POLICY_RELEASES, PolicyEngine, PolicyRegistry, loadPolicyRegistry } from "../src/index.js";
import { catalogRef, catalogs, policyDocument, policyError, rule, subject } from "./helpers.js";

const release = (document: unknown, registry = catalogs) => ({
  document,
  policyHash: new PolicyEngine(document, registry).policyHash,
});

// 1.0.0 allows GitHub org membership; 1.1.0 changes it to require approval.
const v1 = policyDocument([rule("baseline")], "1.0.0");
const v1_1 = policyDocument(
  [rule("baseline", { decision: "REQUIRES_APPROVAL", reasonCode: "NOW_NEEDS_APPROVAL" })],
  "1.1.0",
);
const request = { subject: subject(), catalog: catalogRef, resourceId: "github-org-membership" };

describe("PolicyRegistry", () => {
  const registry = new PolicyRegistry({
    releases: [release(v1_1), release(v1)],
    currentVersion: "1.1.0",
    catalogs,
  });

  it("resolves historical versions and replays old decisions unchanged", () => {
    expect(registry.versions).toEqual(["1.0.0", "1.1.0"]);
    const recorded = registry.get("1.0.0").evaluate(request);
    expect(recorded.decision).toBe("ALLOW");
    expect(registry.current.evaluate(request).decision).toBe("REQUIRES_APPROVAL");

    const replay = registry.replay(recorded, request);
    expect(replay.matches).toBe(true);
    expect(replay.decision).toEqual(recorded);
    expect(registry.resolve(recorded).policyVersion).toBe("1.0.0");
  });

  it("detects a recorded decision that its policy version would not produce", () => {
    const recorded = registry.get("1.0.0").evaluate(request);
    const tampered = { ...recorded, decision: "DENY" as const };
    expect(registry.replay(tampered, request).matches).toBe(false);
  });

  it("rejects unknown versions and hash mismatches", () => {
    expect(policyError(() => registry.get("3.0.0")).code).toBe("UNKNOWN_POLICY_VERSION");
    const wrongHash = { policyVersion: "1.0.0", policyHash: registry.get("1.1.0").policyHash };
    expect(policyError(() => registry.resolve(wrongHash)).code).toBe("POLICY_VERSION_MISMATCH");
    const recorded = {
      ...registry.get("1.0.0").evaluate(request),
      policyHash: wrongHash.policyHash,
    };
    expect(policyError(() => registry.replay(recorded, request)).code).toBe(
      "POLICY_VERSION_MISMATCH",
    );
  });

  it("refuses a released policy whose content changed after release", () => {
    const pinned = release(v1);
    const edited = policyDocument([rule("baseline", { reasonCode: "EDITED" })], "1.0.0");
    const err = policyError(
      () =>
        new PolicyRegistry({
          releases: [{ document: edited, policyHash: pinned.policyHash }],
          currentVersion: "1.0.0",
          catalogs,
        }),
    );
    expect(err.code).toBe("INVALID_POLICY");
    expect(err.message).toContain("Released policies are immutable");
  });

  it("refuses duplicate releases and an unreleased current version", () => {
    for (const options of [
      { releases: [release(v1), release(v1)], currentVersion: "1.0.0" },
      { releases: [release(v1)], currentVersion: "1.1.0" },
    ]) {
      expect(policyError(() => new PolicyRegistry({ ...options, catalogs })).code).toBe(
        "INVALID_POLICY",
      );
    }
  });

  it("requires the current policy to be bound to the current catalog", () => {
    const current = CATALOG_RELEASES[0]!;
    const nextDoc = { ...(current.document as object), catalogVersion: "1.1.0" };
    const twoCatalogs = new CatalogRegistry({
      releases: [
        current,
        { document: nextDoc, catalogHash: new ResourceCatalog(nextDoc).catalogHash },
      ],
      currentVersion: "1.1.0",
    });
    const err = policyError(
      () =>
        new PolicyRegistry({
          releases: [release(v1, twoCatalogs)],
          currentVersion: "1.0.0",
          catalogs: twoCatalogs,
        }),
    );
    expect(err.message).toContain("not the current catalog 1.1.0");
  });
});

describe("released policies", () => {
  it("load, match their pinned hashes and ship exactly the released files", () => {
    const registry = loadPolicyRegistry();
    expect(registry.versions).toEqual(["1.0.0"]);
    expect(registry.current.catalog.reference).toEqual(catalogRef);
    const files = readdirSync(new URL("../src/releases/", import.meta.url)).sort();
    const released = POLICY_RELEASES.map(
      (r) => `${(r.document as { policyVersion: string }).policyVersion}.json`,
    ).sort();
    expect(files).toEqual(released);
  });
});
