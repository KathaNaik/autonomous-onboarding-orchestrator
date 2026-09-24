import {
  CATALOG_ENVIRONMENTS,
  CATALOG_PROVIDERS,
  CatalogHashSchema,
  CatalogReferenceSchema,
  CatalogVersionSchema,
  ResourceIdSchema,
} from "@aoo/catalog";
import { z } from "zod";

export const POLICY_DECISIONS = ["ALLOW", "DENY", "REQUIRES_APPROVAL"] as const;
export type PolicyDecisionValue = (typeof POLICY_DECISIONS)[number];

/** Precedence among matching rules: the first effect with a match wins; nothing matched → DENY. */
export const DECISION_PRECEDENCE: readonly PolicyDecisionValue[] = Object.freeze([
  "DENY",
  "REQUIRES_APPROVAL",
  "ALLOW",
]);

export const EMPLOYMENT_TYPES = ["FULL_TIME", "CONTRACTOR", "INTERN"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Upper-snake codes: departments, role families and reason codes. */
export const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
export const RULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const code = z.string().max(64).regex(CODE_PATTERN, "must be UPPER_SNAKE_CASE");

/**
 * Explicit, validated facts about the hire. Authorization depends only on these (and the policy
 * and catalog data): never on free-text job descriptions or agent reasoning.
 */
export const PolicySubjectSchema = z.strictObject({
  /** Recorded for attribution; no rule matches on it. */
  employeeId: z.string().trim().min(1).max(100),
  department: code,
  roleFamily: code,
  employmentType: z.enum(EMPLOYMENT_TYPES),
});
export type PolicySubject = z.infer<typeof PolicySubjectSchema>;

export const PolicyRequestSchema = z.strictObject({
  subject: PolicySubjectSchema,
  /** The catalog version the requested ids come from (the recommendation's CatalogReference). */
  catalog: CatalogReferenceSchema,
  /** Not restricted to the id format: anything not in the catalog is decided as UNKNOWN_RESOURCE. */
  resourceId: z.string().min(1).max(200),
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export const PolicyBatchRequestSchema = z.strictObject({
  subject: PolicySubjectSchema,
  catalog: CatalogReferenceSchema,
  resourceIds: z.array(z.string().min(1).max(200)).max(200),
});
export type PolicyBatchRequest = z.infer<typeof PolicyBatchRequestSchema>;

const values = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1, "must not be empty (omit the condition to match anything)")
    .max(100)
    .refine((list) => new Set(list).size === list.length, "must not repeat values");

/**
 * Conditions of a rule. Every present field must match (AND); within a field any listed value
 * matches (OR); an absent field matches anything. `environments` never matches a resource
 * whose environment is null.
 */
export const RuleConditionsSchema = z.strictObject({
  departments: values(code).optional(),
  roleFamilies: values(code).optional(),
  employmentTypes: values(z.enum(EMPLOYMENT_TYPES)).optional(),
  resourceIds: values(ResourceIdSchema).optional(),
  environments: values(z.enum(CATALOG_ENVIRONMENTS)).optional(),
  providers: values(z.enum(CATALOG_PROVIDERS)).optional(),
});
export type RuleConditions = z.infer<typeof RuleConditionsSchema>;

export const PolicyRuleSchema = z.strictObject({
  ruleId: z.string().max(64).regex(RULE_ID_PATTERN, "rule id must be lowercase kebab-case"),
  decision: z.enum(POLICY_DECISIONS),
  reasonCode: code,
  explanation: z.string().trim().min(1).max(500),
  when: RuleConditionsSchema,
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/** One released policy version, exactly as stored in src/releases/<version>.json. */
export const PolicyDocumentSchema = z.strictObject({
  policyVersion: CatalogVersionSchema,
  /** The exact catalog release every resource id in this policy refers to. */
  catalog: CatalogReferenceSchema,
  /** Closed vocabularies: rules may only name these values, and other values match no rule. */
  subjectAttributes: z.strictObject({
    departments: values(code),
    roleFamilies: values(code),
  }),
  rules: z.array(PolicyRuleSchema).min(1).max(200),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** What a recorded decision carries to pin the exact policy content that produced it. */
export const PolicyReferenceSchema = z.strictObject({
  policyVersion: CatalogVersionSchema,
  policyHash: CatalogHashSchema,
});
export type PolicyReference = z.infer<typeof PolicyReferenceSchema>;

/** Built-in fail-closed rules, evaluated before policy rules. */
export const BUILTIN_RULES = Object.freeze({
  UNKNOWN_RESOURCE: "builtin.unknown-resource",
  RESOURCE_DISABLED: "builtin.disabled-resource",
  UNKNOWN_SUBJECT_ATTRIBUTE: "builtin.unknown-subject-attribute",
  NO_MATCHING_ALLOW_RULE: "builtin.default-deny",
} as const);
export const BUILTIN_REASON_CODES = Object.freeze(
  Object.keys(BUILTIN_RULES),
) as readonly (keyof typeof BUILTIN_RULES)[];

/** One decision for one resource. The durable audit fields are matchedRuleId and reasonCode. */
export const PolicyDecisionSchema = z.strictObject({
  resourceId: z.string(),
  decision: z.enum(POLICY_DECISIONS),
  matchedRuleId: z.string(),
  reasonCode: code,
  explanation: z.string(),
  policyVersion: CatalogVersionSchema,
  policyHash: CatalogHashSchema,
  catalogVersion: CatalogVersionSchema,
  catalogHash: CatalogHashSchema,
  /** Direct catalog dependencies, for information only: each needs its own decision. */
  dependsOn: z.array(ResourceIdSchema),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
