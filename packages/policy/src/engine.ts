import { createHash } from "node:crypto";
import {
  CatalogError,
  canonicalJson,
  type CatalogReference,
  type CatalogRegistry,
  type ResourceCatalog,
} from "@aoo/catalog";
import type { z } from "zod";
import { PolicyError } from "./errors.js";
import {
  BUILTIN_RULES,
  PolicyBatchRequestSchema,
  PolicyRequestSchema,
  type PolicyDecision,
  type PolicyDecisionValue,
  type PolicyDocument,
  type PolicyReference,
  type PolicyRule,
  type PolicyRequest,
  type PolicyBatchRequest,
} from "./schema.js";
import { decidingRules, parsePolicyDocument, validatePolicyAgainstCatalog } from "./validate.js";

/** Immutable metadata of one policy version. */
export interface PolicySnapshot {
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly catalog: CatalogReference;
  readonly subjectAttributes: {
    readonly departments: readonly string[];
    readonly roleFamilies: readonly string[];
  };
  readonly ruleCount: number;
  readonly rules: readonly PolicyRule[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Content hash of a normalized policy document. */
export function policyHash(document: PolicyDocument): string {
  return `sha256:${createHash("sha256").update(canonicalJson(document)).digest("hex")}`;
}

function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
  );
  throw new PolicyError("INVALID_REQUEST", `invalid policy request: ${issues.join("; ")}`, {
    issues,
  });
}

/**
 * One loaded, validated, frozen policy version bound to one catalog release. Pure: evaluation
 * reads only its arguments and this frozen data, so the same inputs always give the same decision.
 */
export class PolicyEngine {
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly reference: PolicyReference;
  readonly catalog: ResourceCatalog;
  private readonly snapshotData: PolicySnapshot;

  /** Resolves the policy's catalog through `catalogs`; any failure is INVALID_POLICY. */
  constructor(input: unknown, catalogs: CatalogRegistry) {
    const document = parsePolicyDocument(input);
    let catalog: ResourceCatalog;
    try {
      catalog = catalogs.resolve(document.catalog);
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      const issue = `catalog reference ${document.catalog.catalogVersion} is not usable: ${err.message}`;
      throw new PolicyError(
        "INVALID_POLICY",
        `policy ${document.policyVersion} is invalid: ${issue}`,
        {
          issues: [issue],
        },
      );
    }
    validatePolicyAgainstCatalog(document, catalog);

    this.policyVersion = document.policyVersion;
    this.policyHash = policyHash(document);
    this.reference = Object.freeze({
      policyVersion: this.policyVersion,
      policyHash: this.policyHash,
    });
    this.catalog = catalog;
    const frozen = deepFreeze(structuredClone(document));
    this.snapshotData = Object.freeze({
      ...this.reference,
      catalog: frozen.catalog,
      subjectAttributes: frozen.subjectAttributes,
      ruleCount: frozen.rules.length,
      rules: frozen.rules,
    });
    Object.freeze(this);
  }

  snapshot(): PolicySnapshot {
    return this.snapshotData;
  }

  /** Decides one resource. Throws only for malformed requests or a catalog mismatch. */
  evaluate(request: PolicyRequest): PolicyDecision {
    const { subject, catalog, resourceId } = parseRequest(PolicyRequestSchema, request);
    this.requireCatalog(catalog);
    return this.decide(subject, resourceId);
  }

  /**
   * Convenience around independent evaluations: one decision per requested resource, sorted by
   * resource id. No decision influences another; duplicates are rejected.
   */
  evaluateAll(request: PolicyBatchRequest): readonly PolicyDecision[] {
    const { subject, catalog, resourceIds } = parseRequest(PolicyBatchRequestSchema, request);
    this.requireCatalog(catalog);
    const duplicates = [...new Set(resourceIds.filter((id, i) => resourceIds.indexOf(id) !== i))];
    if (duplicates.length > 0) {
      throw new PolicyError(
        "DUPLICATE_RESOURCE",
        `resource(s) requested more than once: ${duplicates.sort(compare).join(", ")}`,
      );
    }
    return Object.freeze(
      [...resourceIds].sort(compare).map((resourceId) => this.decide(subject, resourceId)),
    );
  }

  /** Throws POLICY_VERSION_MISMATCH unless the reference names exactly this policy content. */
  assertReference(reference: PolicyReference): void {
    if (
      reference.policyVersion !== this.policyVersion ||
      reference.policyHash !== this.policyHash
    ) {
      throw new PolicyError(
        "POLICY_VERSION_MISMATCH",
        `reference ${reference.policyVersion} (${reference.policyHash}) does not match policy ` +
          `${this.policyVersion} (${this.policyHash})`,
      );
    }
  }

  private requireCatalog(reference: CatalogReference): void {
    const own = this.catalog.reference;
    if (
      reference.catalogVersion !== own.catalogVersion ||
      reference.catalogHash !== own.catalogHash
    ) {
      throw new PolicyError(
        "CATALOG_MISMATCH",
        `request uses catalog ${reference.catalogVersion} (${reference.catalogHash}), but policy ` +
          `${this.policyVersion} is bound to catalog ${own.catalogVersion} (${own.catalogHash})`,
      );
    }
  }

  private decide(subject: PolicyRequest["subject"], resourceId: string): PolicyDecision {
    const result = (
      decision: PolicyDecisionValue,
      matchedRuleId: string,
      reasonCode: string,
      explanation: string,
      dependsOn: readonly string[] = [],
    ): PolicyDecision =>
      deepFreeze({
        resourceId,
        decision,
        matchedRuleId,
        reasonCode,
        explanation,
        ...this.reference,
        ...this.catalog.reference,
        dependsOn: [...dependsOn],
      });

    if (!this.catalog.hasResource(resourceId)) {
      return result(
        "DENY",
        BUILTIN_RULES.UNKNOWN_RESOURCE,
        "UNKNOWN_RESOURCE",
        `Resource "${resourceId}" is not in catalog ${this.catalog.catalogVersion}; unknown resources are denied.`,
      );
    }
    const resource = this.catalog.getResource(resourceId);
    if (!resource.enabled) {
      return result(
        "DENY",
        BUILTIN_RULES.RESOURCE_DISABLED,
        "RESOURCE_DISABLED",
        `Resource "${resourceId}" is disabled in catalog ${this.catalog.catalogVersion}; disabled resources are denied.`,
        resource.dependsOn,
      );
    }
    const { departments, roleFamilies } = this.snapshotData.subjectAttributes;
    if (!departments.includes(subject.department) || !roleFamilies.includes(subject.roleFamily)) {
      return result(
        "DENY",
        BUILTIN_RULES.UNKNOWN_SUBJECT_ATTRIBUTE,
        "UNKNOWN_SUBJECT_ATTRIBUTE",
        `Department ${subject.department} or role family ${subject.roleFamily} is not defined in ` +
          `policy ${this.policyVersion}; unknown attributes are denied.`,
        resource.dependsOn,
      );
    }
    const winners = decidingRules(this.snapshotData.rules, { ...subject, resource });
    // Unreachable for a loaded policy: load-time analysis rejects overlapping same-effect rules.
    if (winners.length > 1)
      throw new Error(`ambiguous rules in validated policy ${this.policyVersion}`);
    const rule = winners[0];
    if (!rule) {
      return result(
        "DENY",
        BUILTIN_RULES.NO_MATCHING_ALLOW_RULE,
        "NO_MATCHING_ALLOW_RULE",
        `No rule in policy ${this.policyVersion} allows "${resourceId}" for department ` +
          `${subject.department}, role family ${subject.roleFamily}; default deny.`,
        resource.dependsOn,
      );
    }
    return result(
      rule.decision,
      rule.ruleId,
      rule.reasonCode,
      rule.explanation,
      resource.dependsOn,
    );
  }
}
