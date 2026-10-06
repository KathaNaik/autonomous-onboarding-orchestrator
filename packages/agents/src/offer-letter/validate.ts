import {
  OfferLetterModelOutputSchema,
  OfferLetterProposalSchema,
  type OfferLetterProposal,
} from "./schema.js";

/** Compensation and personal-identifier patterns that must never be stored or shown. */
const COMPENSATION =
  /[$€£₹¥]\s?\d|\b\d{1,3}(,\d{3})+(\.\d+)?\b|\b(salary|compensation|bonus|equity|stock options?|rsus?|per (year|annum|hour)|annual(ly)? (pay|base)|signing bonus)\b/i;
const PERSONAL = /\b\d{3}-\d{2}-\d{4}\b|\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}[.-]\d{3}[.-]\d{4}\b/;
/**
 * Code-like UPPER_SNAKE tokens (FULL_TIME, SOFTWARE_ENGINEER, AWS_PROD, …): canonical policy codes
 * and resource-style identifiers are never proposed from a document; they are the operator's choice.
 */
const CODE_TOKEN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/;
/** Instructions addressed to a model ("ignore previous instructions", "system override"). */
const INSTRUCTION =
  /\b(ignore|disregard|override|forget)\b.{0,40}\b(instructions?|prompts?|rules)\b|\bsystem (prompt|override|message)\b/i;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type OfferLetterValidation =
  { ok: true; proposal: OfferLetterProposal } | { ok: false; fields: string[] };

const clean = (v: string | null) => {
  if (v === null) return null;
  const t = v.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
};

function validDate(v: string | null): boolean {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Deterministic post-processing of the model output. Contract violations reject the output
 * (retried by the agent); content problems never pass through: a field carrying compensation or a
 * personal identifier is dropped (the summary keeps only clean sentences), an invalid email or
 * date becomes null, and each change is reported as a warning code.
 */
export function validateOfferLetterOutput(raw: unknown): OfferLetterValidation {
  const parsed = OfferLetterModelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))],
    };
  }
  const o = parsed.data;
  const warnings = new Set<string>(o.warnings);
  const scrub = (name: string, v: string | null) => {
    const c = clean(v);
    if (c && (COMPENSATION.test(c) || PERSONAL.test(c))) {
      warnings.add(`SENSITIVE_CONTENT_REMOVED:${name}`);
      return null;
    }
    if (c && CODE_TOKEN.test(c)) {
      warnings.add(`CODE_REMOVED:${name}`);
      return null;
    }
    if (c && INSTRUCTION.test(c)) {
      warnings.add(`INSTRUCTION_REMOVED:${name}`);
      return null;
    }
    return c;
  };
  let jobSummary = clean(o.jobSummary);
  if (jobSummary) {
    const sentences = jobSummary.split(/(?<=[.!?])\s+/);
    const sensitive = sentences.filter((s) => COMPENSATION.test(s) || PERSONAL.test(s));
    const coded = sentences.filter((s) => !sensitive.includes(s) && CODE_TOKEN.test(s));
    const injected = sentences.filter(
      (s) => !sensitive.includes(s) && !coded.includes(s) && INSTRUCTION.test(s),
    );
    const kept = sentences.filter(
      (s) => !sensitive.includes(s) && !coded.includes(s) && !injected.includes(s),
    );
    if (sensitive.length) warnings.add("SENSITIVE_CONTENT_REMOVED:jobSummary");
    if (coded.length) warnings.add("CODE_REMOVED:jobSummary");
    if (injected.length) warnings.add("INSTRUCTION_REMOVED:jobSummary");
    jobSummary = kept.length ? kept.join(" ") : null;
  }
  let workEmail = clean(o.workEmail);
  if (workEmail && !EMAIL.test(workEmail)) {
    warnings.add("EMAIL_UNREADABLE");
    workEmail = null;
  }
  let startDate = clean(o.startDate);
  if (startDate && !validDate(startDate)) {
    warnings.add("AMBIGUOUS_START_DATE");
    startDate = null;
  }
  const proposal = OfferLetterProposalSchema.parse({
    isOfferLetter: o.isOfferLetter,
    firstName: scrub("firstName", o.firstName),
    lastName: scrub("lastName", o.lastName),
    workEmail: workEmail?.toLowerCase() ?? null,
    jobTitle: scrub("jobTitle", o.jobTitle),
    department: scrub("department", o.department),
    managerName: scrub("managerName", o.managerName),
    startDate,
    jobSummary,
    warnings: [...warnings].sort(),
  });
  return { ok: true, proposal: Object.freeze(proposal) };
}
