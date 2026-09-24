import { z } from "zod";

/** Who (deterministically) fulfils a resource. M5A records it; no adapter is called. */
export const CATALOG_PROVIDERS = ["SERVICENOW", "OKTA", "GITHUB", "MANUAL", "NONE"] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

export const CATALOG_CATEGORIES = [
  "IDENTITY",
  "SOURCE_CONTROL",
  "COLLABORATION",
  "PROJECT_MANAGEMENT",
  "CLOUD_INFRASTRUCTURE",
  "DEVELOPER_TOOLS",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export const CATALOG_ENVIRONMENTS = ["DEVELOPMENT", "STAGING", "PRODUCTION"] as const;
export type CatalogEnvironment = (typeof CATALOG_ENVIRONMENTS)[number];

/** Input for the future policy engine. Not a decision: the catalog never authorizes anything. */
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Strict semver MAJOR.MINOR.PATCH, no leading zeros, no pre-release suffix. */
export const CATALOG_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Lowercase kebab-case slug. */
export const RESOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CATALOG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const CatalogVersionSchema = z
  .string()
  .regex(CATALOG_VERSION_PATTERN, "catalog version must be MAJOR.MINOR.PATCH");
export const ResourceIdSchema = z
  .string()
  .max(64)
  .regex(RESOURCE_ID_PATTERN, "resource id must be lowercase kebab-case");
export const CatalogHashSchema = z.string().regex(CATALOG_HASH_PATTERN);

/** What a workflow or recommendation records to pin the exact catalog content it used. */
export const CatalogReferenceSchema = z.strictObject({
  catalogVersion: CatalogVersionSchema,
  catalogHash: CatalogHashSchema,
});
export type CatalogReference = z.infer<typeof CatalogReferenceSchema>;

const name = z.string().trim().min(1).max(100);
const slug = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(100);

const resourceBase = {
  resourceId: ResourceIdSchema,
  displayName: name,
  description: z.string().trim().min(1).max(500),
  category: z.enum(CATALOG_CATEGORIES),
  /** Null when the resource is not environment-specific. */
  environment: z.enum(CATALOG_ENVIRONMENTS).nullable(),
  /** Disabled resources stay in the version (history) but can't be recommended. */
  enabled: z.boolean(),
  /** Resources that must be provisioned first. Explicit per resource; there is no implicit root. */
  dependsOn: z.array(ResourceIdSchema).max(20),
  riskLevel: z.enum(RISK_LEVELS),
};

/** Provider metadata for the future deterministic adapters, validated per provider. */
export const CatalogResourceDefinitionSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    ...resourceBase,
    provider: z.literal("SERVICENOW"),
    providerMetadata: z.strictObject({ assignmentGroup: name }),
  }),
  z.strictObject({
    ...resourceBase,
    provider: z.literal("OKTA"),
    providerMetadata: z.strictObject({ groupName: name }),
  }),
  z.strictObject({
    ...resourceBase,
    provider: z.literal("GITHUB"),
    providerMetadata: z.strictObject({ organization: slug, team: slug.nullable() }),
  }),
  z.strictObject({
    ...resourceBase,
    provider: z.literal("MANUAL"),
    providerMetadata: z.strictObject({
      fulfillmentTeam: name,
      instructions: z.string().trim().min(1).max(500),
    }),
  }),
  z.strictObject({
    ...resourceBase,
    provider: z.literal("NONE"),
    providerMetadata: z.strictObject({}),
  }),
]);
export type CatalogResourceDefinition = z.infer<typeof CatalogResourceDefinitionSchema>;

/** A resource as served by a loaded catalog: its definition stamped with the version it came from. */
export type CatalogResource = Readonly<CatalogResourceDefinition> & {
  readonly catalogVersion: string;
};

/**
 * One released catalog version, exactly as stored in src/versions/<version>.json.
 * Structural checks only; graph checks (unique ids, dependencies) are in validate.ts.
 */
export const CatalogDocumentSchema = z.strictObject({
  catalogVersion: CatalogVersionSchema,
  resources: z.array(CatalogResourceDefinitionSchema).min(1).max(500),
});
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;
