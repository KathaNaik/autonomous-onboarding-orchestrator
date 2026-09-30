import { z } from "zod";

/**
 * Onboarding Plan Agent (M8) contracts. The model sees only the human-readable
 * OnboardingPlanModelInput and may return only an OnboardingPlanModelOutput: a short summary and a
 * bounded checklist. No field can carry an authorization, an action or free-form metadata.
 */

export const ONBOARDING_PLAN_PHASES = ["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"] as const;
export type OnboardingPlanPhase = (typeof ONBOARDING_PLAN_PHASES)[number];

export const ONBOARDING_PLAN_TASK_CATEGORIES = [
  "ACCOUNT_SETUP",
  "TOOL_ORIENTATION",
  "SECURITY",
  "TEAM_ONBOARDING",
  "ROLE_RAMP",
  "FIRST_DELIVERABLE",
] as const;
export type OnboardingPlanTaskCategory = (typeof ONBOARDING_PLAN_TASK_CATEGORIES)[number];

/** Model-facing availability of a settled resource. Never says why it is unavailable. */
export const RESOURCE_AVAILABILITIES = ["AVAILABLE", "NOT_AVAILABLE"] as const;
export type ResourceAvailability = (typeof RESOURCE_AVAILABILITIES)[number];

export const ONBOARDING_PLAN_LIMITS = Object.freeze({
  summaryMax: 500,
  tasksMin: 3,
  tasksMax: 12,
  titleMax: 120,
  instructionMax: 500,
  resourceIdsPerTaskMax: 5,
});

const text = (max: number) => z.string().trim().min(1).max(max);

export const OnboardingPlanTaskSchema = z.strictObject({
  phase: z.enum(ONBOARDING_PLAN_PHASES),
  category: z.enum(ONBOARDING_PLAN_TASK_CATEGORIES),
  title: text(ONBOARDING_PLAN_LIMITS.titleMax),
  instruction: text(ONBOARDING_PLAN_LIMITS.instructionMax),
  /** Only AVAILABLE resources of the input (checked after parsing). */
  resourceIds: z.array(z.string().min(1).max(64)).max(ONBOARDING_PLAN_LIMITS.resourceIdsPerTaskMax),
});
export type OnboardingPlanTask = z.infer<typeof OnboardingPlanTaskSchema>;

/**
 * The model's whole structured output. Structural only: resource membership, availability,
 * uniqueness and forbidden content are checked afterwards (validateOnboardingPlan).
 */
export const OnboardingPlanModelOutputSchema = z.strictObject({
  summary: text(ONBOARDING_PLAN_LIMITS.summaryMax),
  tasks: z
    .array(OnboardingPlanTaskSchema)
    .min(ONBOARDING_PLAN_LIMITS.tasksMin)
    .max(ONBOARDING_PLAN_LIMITS.tasksMax),
});
export type OnboardingPlanModelOutput = z.infer<typeof OnboardingPlanModelOutputSchema>;

export const ONBOARDING_PLAN_OUTPUT_SCHEMA_NAME = "onboarding_plan";

/**
 * Strict JSON Schema for provider-side Structured Outputs (every property required, no
 * additional properties). Lengths and counts are enforced by the Zod schema afterwards; a unit
 * test keeps the two in step.
 */
export const ONBOARDING_PLAN_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "tasks"],
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "category", "title", "instruction", "resourceIds"],
        properties: {
          phase: { type: "string", enum: [...ONBOARDING_PLAN_PHASES] },
          category: { type: "string", enum: [...ONBOARDING_PLAN_TASK_CATEGORIES] },
          title: { type: "string" },
          instruction: { type: "string" },
          resourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
});

/** A settled resource as the model sees it: display data and availability only. */
export const PlanResourceSchema = z.strictObject({
  resourceId: z.string().min(1).max(64),
  displayName: text(200),
  description: text(1000),
  availability: z.enum(RESOURCE_AVAILABILITIES),
});
export type PlanResource = z.infer<typeof PlanResourceSchema>;

/**
 * Exactly what the model receives besides the versioned system prompt (hashed as inputHash and
 * persisted as the run's input snapshot). Human-readable labels only: no database, workflow,
 * decision, request, ticket, provider or policy identifiers.
 */
export const OnboardingPlanModelInputSchema = z.strictObject({
  employee: z.strictObject({
    departmentLabel: text(100),
    roleFamilyLabel: text(100),
    employmentTypeLabel: text(100),
    /** HRIS display title (free text). */
    jobTitle: text(200).nullable(),
    /** Untrusted HRIS free text; data only. */
    jobDescription: text(4000).nullable(),
  }),
  resources: z.array(PlanResourceSchema).max(100),
});
export type OnboardingPlanModelInput = z.infer<typeof OnboardingPlanModelInputSchema>;

/** A plan after post-model validation (trimmed; tasks in model order). */
export interface ValidatedOnboardingPlan {
  readonly summary: string;
  readonly tasks: readonly Readonly<OnboardingPlanTask>[];
}
