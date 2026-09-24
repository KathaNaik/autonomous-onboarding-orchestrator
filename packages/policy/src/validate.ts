import type { CatalogResource, ResourceCatalog } from "@aoo/catalog";
import { PolicyError } from "./errors.js";
import {
  BUILTIN_REASON_CODES,
  DECISION_PRECEDENCE,
  EMPLOYMENT_TYPES,
  PolicyDocumentSchema,
  type EmploymentType,
  type PolicyDocument,
  type PolicyRule,
  type RuleConditions,
} from "./schema.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The facts a rule can see. */
export interface MatchFacts {
  department: string;
  roleFamily: string;
  employmentType: EmploymentType;
  resource: CatalogResource;
}

/** Pure condition matching: AND across present fields, OR within a field. */
export function ruleMatches(when: RuleConditions, facts: MatchFacts): boolean {
  const { resource } = facts;
  return (
    (!when.departments || when.departments.includes(facts.department)) &&
    (!when.roleFamilies || when.roleFamilies.includes(facts.roleFamily)) &&
    (!when.employmentTypes || when.employmentTypes.includes(facts.employmentType)) &&
    (!when.resourceIds || when.resourceIds.includes(resource.resourceId)) &&
    (!when.environments ||
      (resource.environment !== null && when.environments.includes(resource.environment))) &&
    (!when.providers || when.providers.includes(resource.provider))
  );
}

/**
 * Applies precedence to the rules matching one set of facts. Returns the deciding rules of the
 * winning effect (exactly one in a valid policy), or [] when nothing matched (default deny).
 */
export function decidingRules(rules: readonly PolicyRule[], facts: MatchFacts): PolicyRule[] {
  const matched = rules.filter((rule) => ruleMatches(rule.when, facts));
  for (const decision of DECISION_PRECEDENCE) {
    const winners = matched.filter((rule) => rule.decision === decision);
    if (winners.length > 0) return winners;
  }
  return [];
}

function invalid(issues: string[], version?: string): PolicyError {
  const label = version ? `policy ${version}` : "policy";
  return new PolicyError(
    "INVALID_POLICY",
    `${label} is invalid (${issues.length} issue(s)): ${issues.join("; ")}`,
    { issues },
  );
}

/** Structural validation plus normalization (rules by id, every list sorted). */
export function parsePolicyDocument(input: unknown): PolicyDocument {
  const parsed = PolicyDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  const sortList = <T extends string>(list: readonly T[] | undefined) =>
    list && [...list].sort(compare);
  const doc = parsed.data;
  return {
    policyVersion: doc.policyVersion,
    catalog: { ...doc.catalog },
    subjectAttributes: {
      departments: sortList(doc.subjectAttributes.departments)!,
      roleFamilies: sortList(doc.subjectAttributes.roleFamilies)!,
    },
    rules: doc.rules
      .map((rule) => ({
        ...rule,
        when: Object.fromEntries(
          Object.entries(rule.when).map(([key, list]) => [key, sortList(list)]),
        ) as RuleConditions,
      }))
      .sort((a, b) => compare(a.ruleId, b.ruleId)),
  };
}

/**
 * Checks a normalized policy against the catalog release it is bound to, then analyses every
 * distinguishable combination of facts. Throws INVALID_POLICY listing every issue found.
 */
export function validatePolicyAgainstCatalog(doc: PolicyDocument, catalog: ResourceCatalog): void {
  const issues: string[] = [];
  const { departments, roleFamilies } = doc.subjectAttributes;
  const seen = new Set<string>();

  for (const rule of doc.rules) {
    const at = `rule "${rule.ruleId}"`;
    if (seen.has(rule.ruleId)) issues.push(`duplicate rule id "${rule.ruleId}"`);
    seen.add(rule.ruleId);
    if ((BUILTIN_REASON_CODES as readonly string[]).includes(rule.reasonCode)) {
      issues.push(`${at} uses reserved built-in reason code ${rule.reasonCode}`);
    }
    const w = rule.when;
    if (Object.keys(w).length === 0) issues.push(`${at} has no conditions`);
    if (rule.decision === "ALLOW" && !w.resourceIds && !w.environments && !w.providers) {
      issues.push(
        `${at} is an ALLOW without a resource condition (resourceIds/environments/providers)`,
      );
    }
    for (const department of w.departments ?? []) {
      if (!departments.includes(department)) {
        issues.push(`${at} names department ${department}, which is not in subjectAttributes`);
      }
    }
    for (const roleFamily of w.roleFamilies ?? []) {
      if (!roleFamilies.includes(roleFamily)) {
        issues.push(`${at} names role family ${roleFamily}, which is not in subjectAttributes`);
      }
    }
    for (const resourceId of w.resourceIds ?? []) {
      if (!catalog.hasResource(resourceId)) {
        issues.push(
          `${at} references unknown resource "${resourceId}" (catalog ${catalog.catalogVersion})`,
        );
      } else if (!catalog.getResource(resourceId).enabled) {
        issues.push(`${at} references disabled resource "${resourceId}"`);
      }
    }
  }
  if (issues.length > 0) throw invalid(issues, doc.policyVersion);

  // Exhaustive analysis. Values no rule mentions behave identically, so one representative of
  // them stands for all; resources are enumerated in full (disabled ones never reach the rules).
  const representatives = (vocabulary: readonly string[], key: "departments" | "roleFamilies") => {
    const mentioned = new Set(doc.rules.flatMap((rule) => rule.when[key] ?? []));
    const other = vocabulary.find((value) => !mentioned.has(value));
    return [...mentioned, ...(other === undefined ? [] : [other])].sort(compare);
  };
  const decisive = new Set<string>();
  const ambiguous = new Map<string, string>();
  for (const department of representatives(departments, "departments")) {
    for (const roleFamily of representatives(roleFamilies, "roleFamilies")) {
      for (const employmentType of EMPLOYMENT_TYPES) {
        for (const resource of catalog.listEnabledResources()) {
          const winners = decidingRules(doc.rules, {
            department,
            roleFamily,
            employmentType,
            resource,
          });
          if (winners.length === 1) decisive.add(winners[0]!.ruleId);
          if (winners.length > 1) {
            const key = winners.map((rule) => rule.ruleId).join(", ");
            if (!ambiguous.has(key)) {
              ambiguous.set(
                key,
                `ambiguous ${winners[0]!.decision} rules [${key}] all match department=${department} ` +
                  `roleFamily=${roleFamily} employmentType=${employmentType} ` +
                  `resource=${resource.resourceId}; same-effect rules must not overlap`,
              );
            }
          }
        }
      }
    }
  }
  issues.push(...ambiguous.values());
  for (const rule of doc.rules) {
    if (
      !decisive.has(rule.ruleId) &&
      ![...ambiguous.keys()].some((k) => k.split(", ").includes(rule.ruleId))
    ) {
      issues.push(
        `rule "${rule.ruleId}" is unreachable: it never decides any request (it matches no ` +
          `enabled resource, or higher-precedence rules always win)`,
      );
    }
  }
  if (issues.length > 0) throw invalid(issues, doc.policyVersion);
}
