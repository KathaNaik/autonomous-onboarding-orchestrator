import { canonicalJson, type CatalogRegistry } from "@aoo/catalog";
import { PolicyEngine } from "./engine.js";
import { PolicyError } from "./errors.js";
import {
  PolicyDecisionSchema,
  PolicyReferenceSchema,
  type PolicyDecision,
  type PolicyReference,
  type PolicyRequest,
} from "./schema.js";

/** A released policy version and the content hash it was released with. */
export interface PolicyRelease {
  readonly document: unknown;
  readonly policyHash: string;
}

export interface ReplayResult {
  /** The decision the recorded policy version produces today. */
  readonly decision: PolicyDecision;
  /** Whether it is identical to the recorded decision, field for field. */
  readonly matches: boolean;
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Every released policy version, loaded and verified at once against the catalog releases. */
export class PolicyRegistry {
  /** The version new decisions use. */
  readonly current: PolicyEngine;
  /** Released versions, ascending. */
  readonly versions: readonly string[];
  private readonly byVersion: ReadonlyMap<string, PolicyEngine>;

  /**
   * Fails as a whole (INVALID_POLICY) if any release is invalid, released twice, no longer
   * matches its pinned hash, or the current policy isn't bound to the current catalog.
   */
  constructor(options: {
    releases: readonly PolicyRelease[];
    currentVersion: string;
    catalogs: CatalogRegistry;
  }) {
    const engines = new Map<string, PolicyEngine>();
    for (const release of options.releases) {
      const engine = new PolicyEngine(release.document, options.catalogs);
      const version = engine.policyVersion;
      if (engines.has(version)) {
        throw new PolicyError("INVALID_POLICY", `policy ${version} is released twice`);
      }
      if (engine.policyHash !== release.policyHash) {
        throw new PolicyError(
          "INVALID_POLICY",
          `policy ${version} does not match its pinned hash (pinned ${release.policyHash}, ` +
            `content ${engine.policyHash}). Released policies are immutable: release a new ` +
            `version instead of editing this one.`,
        );
      }
      engines.set(version, engine);
    }
    const current = engines.get(options.currentVersion);
    if (!current) {
      throw new PolicyError(
        "INVALID_POLICY",
        `current policy version ${options.currentVersion} is not released`,
      );
    }
    const currentCatalog = options.catalogs.current.reference;
    if (current.catalog.catalogHash !== currentCatalog.catalogHash) {
      throw new PolicyError(
        "INVALID_POLICY",
        `current policy ${current.policyVersion} is bound to catalog ` +
          `${current.catalog.catalogVersion}, not the current catalog ` +
          `${currentCatalog.catalogVersion}: release a policy for the current catalog`,
      );
    }
    this.current = current;
    this.versions = Object.freeze([...engines.keys()].sort(compareVersions));
    this.byVersion = engines;
    Object.freeze(this);
  }

  /** Throws UNKNOWN_POLICY_VERSION for versions that were never released. */
  get(policyVersion: string): PolicyEngine {
    const engine = this.byVersion.get(policyVersion);
    if (!engine) {
      throw new PolicyError(
        "UNKNOWN_POLICY_VERSION",
        `policy version ${policyVersion} is not released (released: ${this.versions.join(", ")})`,
      );
    }
    return engine;
  }

  /** The exact policy a recorded decision used, or UNKNOWN_POLICY_VERSION / POLICY_VERSION_MISMATCH. */
  resolve(reference: PolicyReference): PolicyEngine {
    // Accepts any record carrying the reference, such as a recorded PolicyDecision.
    const parsed = PolicyReferenceSchema.safeParse({
      policyVersion: reference.policyVersion,
      policyHash: reference.policyHash,
    });
    if (!parsed.success) {
      throw new PolicyError("POLICY_VERSION_MISMATCH", "malformed policy reference");
    }
    const engine = this.get(parsed.data.policyVersion);
    engine.assertReference(parsed.data);
    return engine;
  }

  /**
   * Re-evaluates a recorded decision with the policy and catalog versions it names (never the
   * current ones) and reports whether the result is identical.
   */
  replay(recorded: PolicyDecision, request: PolicyRequest): ReplayResult {
    const decisionRecord = PolicyDecisionSchema.parse(recorded);
    const engine = this.resolve(decisionRecord);
    const decision = engine.evaluate(request);
    const matches = canonicalJson(decision) === canonicalJson(decisionRecord);
    return Object.freeze({ decision, matches });
  }
}
