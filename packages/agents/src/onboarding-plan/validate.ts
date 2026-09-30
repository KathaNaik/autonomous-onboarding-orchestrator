import {
  OnboardingPlanModelOutputSchema,
  type OnboardingPlanModelInput,
  type ValidatedOnboardingPlan,
} from "./schema.js";

/** Why a schema-valid plan was rejected. Codes only: never the offending text. */
export const PLAN_VIOLATION_CODES = [
  "UNKNOWN_RESOURCE",
  "UNAVAILABLE_RESOURCE",
  "DUPLICATE_RESOURCE_ID",
  "DUPLICATE_TASK",
  "UNAVAILABLE_RESOURCE_MENTION",
  "URL_NOT_ALLOWED",
  "EMAIL_NOT_ALLOWED",
  "TIME_NOT_ALLOWED",
  "INTERNAL_IDENTIFIER",
  "SECRET_LIKE",
] as const;
export type PlanViolationCode = (typeof PLAN_VIOLATION_CODES)[number];

export interface PlanViolation {
  readonly code: PlanViolationCode;
  /** Resource ids involved (input or catalog ids only, never model free text). */
  readonly resourceIds?: readonly string[];
}

export interface PlanValidationContext {
  readonly input: OnboardingPlanModelInput;
  /**
   * Every resource id of the exact historical catalog (never sent to the model). A plan that
   * names one outside the AVAILABLE set is rejected.
   */
  readonly catalogResourceIds?: readonly string[];
  /**
   * Internal identifiers that must never appear in plan text (workflow/request/decision ids, ticket
   * numbers, policy rule ids and reason codes, provider ids…). Never sent to the model.
   */
  readonly forbiddenTerms?: readonly string[];
}

export type PlanValidationResult =
  | { readonly ok: true; readonly plan: ValidatedOnboardingPlan }
  | { readonly ok: false; readonly kind: "MALFORMED"; readonly fields: readonly string[] }
  | { readonly ok: false; readonly kind: "INVALID"; readonly violations: readonly PlanViolation[] };

const TEXT_RULES: readonly (readonly [PlanViolationCode, RegExp])[] = [
  [
    "URL_NOT_ALLOWED",
    /\b(?:https?|ftp):\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|ai|co|cloud|internal|corp|local)\b/i,
  ],
  ["EMAIL_NOT_ALLOWED", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  [
    "TIME_NOT_ALLOWED",
    /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i,
  ],
  [
    "INTERNAL_IDENTIFIER",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\b[A-Z]{2,6}\d{6,}\b/i,
  ],
  [
    "SECRET_LIKE",
    /\bsk-[A-Za-z0-9_-]{10,}|\bgh[pousr]_[A-Za-z0-9]{10,}|\bgithub_pat_|\bbearer\s+[A-Za-z0-9._~+/-]{10,}|\bSSWS\s+\S{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/i,
  ],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) =>
  new RegExp(`(?<![a-z0-9-])${escape(term.toLowerCase())}(?![a-z0-9-])`).test(text);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Post-model validation (mandatory). Parses with the local Zod contract, then checks every
 * resource reference against the input's AVAILABLE resources and scans all plan text for URLs,
 * e-mail addresses, clock times, internal identifiers, secret-like strings and mentions of
 * resources that are not AVAILABLE. Any violation rejects the whole plan: nothing is repaired or
 * silently dropped.
 */
export function validateOnboardingPlan(
  output: unknown,
  ctx: PlanValidationContext,
): PlanValidationResult {
  const parsed = OnboardingPlanModelOutputSchema.safeParse(output);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    return { ok: false, kind: "MALFORMED", fields: fields.slice(0, 10) };
  }
  const plan = parsed.data;
  const byId = new Map(ctx.input.resources.map((r) => [r.resourceId, r]));
  const available = new Set(
    ctx.input.resources.filter((r) => r.availability === "AVAILABLE").map((r) => r.resourceId),
  );
  const violations = new Map<PlanViolationCode, Set<string>>();
  const flag = (code: PlanViolationCode, resourceId?: string) => {
    const ids = violations.get(code) ?? new Set<string>();
    if (resourceId !== undefined) ids.add(resourceId);
    violations.set(code, ids);
  };

  // 1. Resource references.
  for (const task of plan.tasks) {
    const seen = new Set<string>();
    for (const id of task.resourceIds) {
      if (seen.has(id)) flag("DUPLICATE_RESOURCE_ID", byId.has(id) ? id : undefined);
      seen.add(id);
      if (!byId.has(id)) flag("UNKNOWN_RESOURCE");
      else if (!available.has(id)) flag("UNAVAILABLE_RESOURCE", id);
    }
  }

  // 2. Duplicate tasks (same title, or same instruction).
  const titles = new Set<string>();
  const instructions = new Set<string>();
  for (const task of plan.tasks) {
    const t = norm(task.title);
    const i = norm(task.instruction);
    if (titles.has(t) || instructions.has(i)) flag("DUPLICATE_TASK");
    titles.add(t);
    instructions.add(i);
  }

  // 3. Text content.
  const texts = [plan.summary, ...plan.tasks.flatMap((t) => [t.title, t.instruction])];
  const lower = texts.map((t) => t.toLowerCase());
  for (const text of texts) {
    for (const [code, re] of TEXT_RULES) if (re.test(text)) flag(code);
  }
  for (const term of ctx.forbiddenTerms ?? []) {
    if (term.length >= 6 && lower.some((t) => t.includes(term.toLowerCase()))) {
      flag("INTERNAL_IDENTIFIER");
    }
  }
  const catalogIds = new Set([...(ctx.catalogResourceIds ?? []), ...byId.keys()]);
  for (const id of catalogIds) {
    if (!available.has(id) && lower.some((t) => mentions(t, id))) {
      flag("UNAVAILABLE_RESOURCE_MENTION", byId.has(id) ? id : undefined);
    }
  }
  const availableNames = ctx.input.resources
    .filter((r) => available.has(r.resourceId))
    .map((r) => r.displayName.toLowerCase());
  for (const r of ctx.input.resources) {
    if (available.has(r.resourceId)) continue;
    const name = r.displayName.toLowerCase();
    // A name contained in an AVAILABLE resource's name can't be told apart; skip it.
    if (availableNames.some((n) => n.includes(name))) continue;
    if (lower.some((t) => mentions(t, name))) flag("UNAVAILABLE_RESOURCE_MENTION", r.resourceId);
  }

  if (violations.size > 0) {
    return {
      ok: false,
      kind: "INVALID",
      violations: [...violations].map(([code, ids]) =>
        Object.freeze({ code, ...(ids.size > 0 && { resourceIds: [...ids].sort() }) }),
      ),
    };
  }
  return {
    ok: true,
    plan: Object.freeze({
      summary: plan.summary,
      tasks: Object.freeze(plan.tasks.map((t) => Object.freeze({ ...t }))),
    }),
  };
}
