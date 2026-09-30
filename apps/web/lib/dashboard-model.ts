/**
 * (M9) Pure presentation helpers for the operator dashboard. States are always shown as text
 * (never color alone); tones are a secondary visual cue.
 */
export type Tone = "done" | "active" | "waiting" | "blocked" | "neutral";

const TONES: Record<string, Tone> = {
  COMPLETED: "done",
  PROVISIONED: "done",
  ACCEPTED: "done",
  SUCCEEDED: "done",
  APPROVED: "done",
  COMPLETE: "done",
  AUTHORIZED_BY_POLICY: "done",
  AUTHORIZED_BY_APPROVAL: "done",
  ALLOW: "done",
  PROVISIONING: "active",
  ONBOARDING_GENERATION: "active",
  POLICY_REVIEW: "active",
  ACCESS_PLANNING: "active",
  READY_FOR_PROVISIONING: "active",
  GENERATING: "active",
  RUNNING: "active",
  IN_PROGRESS: "active",
  ACTIVE: "active",
  AWAITING_APPROVAL: "waiting",
  PENDING_APPROVAL: "waiting",
  REQUIRES_APPROVAL: "waiting",
  MANUAL_ACTION_REQUIRED: "waiting",
  PENDING: "waiting",
  OUTCOME_UNKNOWN: "waiting",
  RECEIVED: "waiting",
  NOT_STARTED: "neutral",
  FAILED: "blocked",
  PROVISIONING_FAILED: "blocked",
  CONFLICT: "blocked",
  DENIED: "blocked",
  DENY: "blocked",
  REJECTED: "blocked",
  DENIED_BY_POLICY: "blocked",
  REJECTED_BY_APPROVER: "blocked",
};

export function toneOf(state: string | null | undefined): Tone {
  return (state && TONES[state]) || "neutral";
}

/** "PROVISIONING_FAILED" → "Provisioning failed". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "Not available";
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "Z");
}

export const PHASE_LABELS: Record<string, string> = {
  DAY_ONE: "Day one",
  FIRST_WEEK: "First week",
  FIRST_30_DAYS: "First 30 days",
};

export const AUTH_LABELS: Record<string, string> = {
  AUTHORIZED_BY_POLICY: "Authorized by policy",
  AUTHORIZED_BY_APPROVAL: "Authorized by approval",
  PENDING_APPROVAL: "Awaiting approval",
  DENIED_BY_POLICY: "Denied by policy",
  REJECTED_BY_APPROVER: "Rejected by approver",
};

export const WORKFLOW_STATE_OPTIONS = [
  "RECEIVED",
  "ACCESS_PLANNING",
  "POLICY_REVIEW",
  "AWAITING_APPROVAL",
  "PROVISIONING",
  "ONBOARDING_GENERATION",
  "COMPLETED",
  "FAILED",
] as const;
