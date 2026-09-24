import type { CatalogEnvironment, CatalogCategory } from "@aoo/catalog";
import { z } from "zod";

/**
 * Why a resource is recommended. A closed set, so the reason code is machine-readable and
 * stable; the free-text `reason` is only a short human explanation.
 */
export const RECOMMENDATION_REASON_CODES = [
  "ROLE_BASELINE",
  "TEAM_ALIGNMENT",
  "JOB_RESPONSIBILITY",
  "COLLABORATION",
  "DEVELOPER_TOOLING",
  "ENVIRONMENT_ACCESS",
] as const;
export type RecommendationReasonCode = (typeof RECOMMENDATION_REASON_CODES)[number];

/** One recommendation as the model must return it. Strict: any extra field is malformed. */
export const ModelRecommendationSchema = z.strictObject({
  resourceId: z.string().min(1).max(200),
  reasonCode: z.enum(RECOMMENDATION_REASON_CODES),
  reason: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
});
export type ModelRecommendation = z.infer<typeof ModelRecommendationSchema>;

/** Name of the structured-output schema sent to the provider. */
export const ROLE_ACCESS_OUTPUT_SCHEMA_NAME = "role_access_recommendations";

/**
 * Strict JSON Schema for provider-side Structured Outputs. Only keywords every strict mode
 * supports (every property required, no additional properties); bounds such as lengths and the
 * confidence range are enforced afterwards by RoleAccessModelOutputSchema. A unit test keeps the
 * two in step.
 */
export const ROLE_ACCESS_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["recommendations"],
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["resourceId", "reasonCode", "reason", "confidence"],
        properties: {
          resourceId: { type: "string" },
          reasonCode: { type: "string", enum: [...RECOMMENDATION_REASON_CODES] },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
});

/**
 * The model's whole structured output. Structural only: uniqueness and catalog membership are
 * checked afterwards (validate.ts), so a semantically invalid answer is reported as such and
 * never retried as if it were a transport glitch. No field can carry a decision or a command.
 */
export const RoleAccessModelOutputSchema = z.strictObject({
  recommendations: z.array(ModelRecommendationSchema).max(50),
});
export type RoleAccessModelOutput = z.infer<typeof RoleAccessModelOutputSchema>;

/** A catalog resource as the model sees it: recommendation-relevant fields only. */
export interface AvailableResource {
  readonly resourceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: CatalogCategory;
  readonly environment: CatalogEnvironment | null;
}

/**
 * Human-readable recommendation context. Free text: it may inform recommendations and never
 * authorization. Canonical employee facts are deliberately absent.
 */
export const RecommendationContextSchema = z.strictObject({
  role: z.string().trim().min(1).max(200),
  department: z.string().trim().min(1).max(200),
  /** Untrusted employee/job content. Null when HRIS sent none. */
  jobDescription: z.string().trim().min(1).max(4000).nullable(),
});
export type RecommendationContext = z.infer<typeof RecommendationContextSchema>;

/** Exactly what is sent to the model besides the versioned system prompt (hashed as inputHash). */
export interface RoleAccessModelInput {
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly employeeContext: RecommendationContext;
  readonly availableResources: readonly AvailableResource[];
}

/** A recommendation after post-model validation, sorted by resource id. */
export type ValidatedRecommendation = Readonly<ModelRecommendation>;

/** Catalog dependency metadata for later orchestration. Never merged into recommendations. */
export interface RecommendationDependency {
  readonly resourceId: string;
  readonly dependsOn: readonly string[];
}
