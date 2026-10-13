import {
  ATTENTION_BLOCKER_CLASSES,
  ATTENTION_BLOCKERS,
  ATTENTION_REQUEST_STATUSES,
  type TimelineEntry,
  type WorkflowObservabilityView,
  type WorkflowSummary,
} from "@aoo/shared";

/**
 * Presentation model for the operator console: plain-language labels, status tones and
 * summaries derived from the read model. Pure functions; nothing here changes behavior, and
 * every raw code stays available on the detail page under technical details.
 */

export type Tone = "green" | "amber" | "blue" | "red" | "gray";

/** "PROVISIONING_FAILED" → "Provisioning failed". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "Not available";
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const WORKFLOW_STATE_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  ACCESS_PLANNING: "Planning access",
  POLICY_REVIEW: "Policy review",
  AWAITING_APPROVAL: "Awaiting approval",
  PROVISIONING: "Provisioning",
  ONBOARDING_GENERATION: "Writing plan",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

export const STATE_FILTERS = [
  "RECEIVED",
  "ACCESS_PLANNING",
  "POLICY_REVIEW",
  "AWAITING_APPROVAL",
  "PROVISIONING",
  "ONBOARDING_GENERATION",
  "COMPLETED",
  "FAILED",
] as const;

const TONES: Record<string, Tone> = {
  // Done
  COMPLETED: "green",
  PROVISIONED: "green",
  ACCEPTED: "green",
  SUCCEEDED: "green",
  APPROVED: "green",
  COMPLETE: "green",
  ALLOW: "green",
  AUTHORIZED_BY_POLICY: "green",
  AUTHORIZED_BY_APPROVAL: "green",
  PROCESSED: "green",
  FULFILLED: "green",
  // Waiting on someone
  AWAITING_APPROVAL: "amber",
  PENDING_APPROVAL: "amber",
  REQUIRES_APPROVAL: "amber",
  MANUAL_ACTION_REQUIRED: "amber",
  PENDING: "amber",
  OUTCOME_UNKNOWN: "amber",
  // Running
  ACCESS_PLANNING: "blue",
  POLICY_REVIEW: "blue",
  PROVISIONING: "blue",
  ONBOARDING_GENERATION: "blue",
  READY_FOR_PROVISIONING: "blue",
  GENERATING: "blue",
  RUNNING: "blue",
  IN_PROGRESS: "blue",
  ACTIVE: "blue",
  // Stopped
  FAILED: "red",
  PROVISIONING_FAILED: "red",
  CONFLICT: "red",
  DENIED: "red",
  DENY: "red",
  REJECTED: "red",
  DENIED_BY_POLICY: "red",
  REJECTED_BY_APPROVER: "red",
  DEAD_LETTERED: "red",
  // Neutral: RECEIVED, NOT_STARTED and anything unknown
};

export function toneOf(code: string | null | undefined): Tone {
  return (code && TONES[code.toUpperCase()]) || "gray";
}

export const stateLabel = (state: string) => WORKFLOW_STATE_LABELS[state] ?? humanize(state);

export const DECISION_LABELS: Record<string, string> = {
  ALLOW: "Allow",
  DENY: "Deny",
  REQUIRES_APPROVAL: "Requires approval",
};

export const AUTHORIZATION_LABELS: Record<string, string> = {
  AUTHORIZED_BY_POLICY: "Allowed by policy",
  AUTHORIZED_BY_APPROVAL: "Approved",
  PENDING_APPROVAL: "Awaiting approval",
  DENIED_BY_POLICY: "Denied by policy",
  REJECTED_BY_APPROVER: "Rejected by approver",
};

export const RESOURCE_STATUS_LABELS: Record<string, string> = {
  READY_FOR_PROVISIONING: "Ready",
  PROVISIONING: "In progress",
  PROVISIONED: "Provisioned",
  PROVISIONING_FAILED: "Failed",
  MANUAL_ACTION_REQUIRED: "Manual setup",
  AWAITING_APPROVAL: "Awaiting approval",
  DENIED: "Not granted",
  REJECTED: "Not granted",
};

export const PLAN_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  GENERATING: "Generating",
  FAILED: "Failed",
  ACCEPTED: "Accepted",
};

export const PROVIDER_LABELS: Record<string, string> = {
  SERVICENOW: "ServiceNow",
  OKTA: "Okta",
  GITHUB: "GitHub",
  MANUAL: "Manual",
  NONE: "None",
  servicenow: "ServiceNow",
  okta: "Okta",
  github: "GitHub",
};
export const providerLabel = (p: string | null | undefined) =>
  p ? (PROVIDER_LABELS[p] ?? humanize(p)) : "Not available";

export const PHASE_LABELS: Record<string, string> = {
  DAY_ONE: "Day one",
  FIRST_WEEK: "First week",
  FIRST_30_DAYS: "First 30 days",
};

export const EMPLOYMENT_LABELS: Record<string, string> = {
  FULL_TIME: "Full-time",
  CONTRACTOR: "Contractor",
};

export const ROLE_FAMILY_LABELS: Record<string, string> = {
  SOFTWARE_ENGINEER: "Software engineer",
  SRE: "Site reliability engineer",
  ENGINEERING_MANAGER: "Engineering manager",
  PRODUCT_MANAGER: "Product manager",
  ACCOUNT_EXECUTIVE: "Account executive",
};

/** Offer-letter proposal field names, as the review form labels them. */
export const PROPOSAL_FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  workEmail: "Work email",
  jobTitle: "Job title",
  department: "Department",
  managerName: "Manager",
  startDate: "Start date",
  jobSummary: "Job description",
};

export function factsLine(
  facts: { departmentCode: string; roleFamilyCode: string; employmentType: string } | null,
): string | null {
  if (!facts) return null;
  return [
    humanize(facts.departmentCode),
    ROLE_FAMILY_LABELS[facts.roleFamilyCode] ?? humanize(facts.roleFamilyCode),
    EMPLOYMENT_LABELS[facts.employmentType] ?? humanize(facts.employmentType),
  ].join(", ");
}

/** "2026-09-30T00:00:08Z" → "Sep 30, 2026, 00:00 UTC" (stable server rendering). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}

/** Relative age for tables ("3 min ago"), with the exact time available as a title. */
export function formatAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : formatTime(iso).split(",").slice(0, 2).join(",");
}

// ---------------------------------------------------------------------------------------------
// Needs attention: plain-language summaries of blockers (raw codes stay on the detail page).

type BlockerLike = {
  resourceId: string;
  displayName?: string | null;
  status: string;
  blocker: string | null;
  blockerClass: string | null;
};

const ATTENTION_STATUSES = new Set<string>(ATTENTION_REQUEST_STATUSES);
const ATTENTION_CODES = new Set<string>(ATTENTION_BLOCKERS);
const ATTENTION_CLASSES = new Set<string>(ATTENTION_BLOCKER_CLASSES);

export function needsAttention(b: BlockerLike): boolean {
  return (
    ATTENTION_STATUSES.has(b.status) ||
    (b.blocker !== null && ATTENTION_CODES.has(b.blocker)) ||
    (b.blockerClass !== null && ATTENTION_CLASSES.has(b.blockerClass))
  );
}

interface Issue {
  kind: string;
  text: string;
  plural: (n: number) => string;
}

/** One blocked resource → what a person should know, in plain words. */
export function describeBlocker(b: BlockerLike): Issue {
  const name = b.displayName ?? humanize(b.resourceId.replace(/-/g, "_"));
  if (b.status === "AWAITING_APPROVAL")
    return { kind: "approval", text: `${name} approval`, plural: (n) => `${n} approvals pending` };
  if (b.status === "MANUAL_ACTION_REQUIRED")
    return {
      kind: "manual",
      text: `Manual setup: ${name}`,
      plural: (n) => `${n} manual setups pending`,
    };
  if (b.status === "PROVISIONING_FAILED")
    return { kind: "failed", text: `${name} failed`, plural: (n) => `${n} resources failed` };
  switch (b.blocker) {
    case "GITHUB_IDENTITY_CLAIM_REQUIRED":
      return {
        kind: "github-username",
        text: "GitHub username required",
        plural: () => "GitHub username required",
      };
    case "GITHUB_INVITATION_PENDING":
      return {
        kind: "github-invite",
        text: "GitHub invitation not accepted yet",
        plural: () => "GitHub invitation not accepted yet",
      };
    case "SERVICENOW_FULFILLMENT_PENDING":
    case "SERVICENOW_FULFILLMENT_IN_PROGRESS":
      return {
        kind: "fulfillment",
        text: `${name} fulfillment pending`,
        plural: (n) => `${n} fulfillments pending`,
      };
    case "DEPENDENCIES_NOT_READY":
      return {
        kind: "dependency",
        text: `${name} waits on another resource`,
        plural: (n) => `${n} resources wait on others`,
      };
    case "TRANSIENT_PROVIDER_FAILURE":
      return { kind: "retry", text: `Retrying ${name}`, plural: (n) => `Retrying ${n} resources` };
    case "PROVIDER_NOT_CONFIGURED":
      return {
        kind: "config",
        text: `${name}: provider not configured`,
        plural: (n) => `${n} resources need configuration`,
      };
    case "MISSING_AUTHORIZED_DEPENDENCY":
    case "DEPENDENCY_NOT_AUTHORIZED":
      return {
        kind: "dependency-denied",
        text: `${name}: a required resource isn't authorized`,
        plural: (n) => `${n} resources blocked by dependencies`,
      };
    case "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE":
      return {
        kind: "github-owned",
        text: `${name}: GitHub account already linked to another employee`,
        plural: (n) => `${n} resources blocked by a GitHub account linked to another employee`,
      };
    case "GITHUB_IDENTITY_NOT_FOUND":
      return {
        kind: "github-not-found",
        text: `${name}: GitHub username not found`,
        plural: (n) => `${n} resources wait for a valid GitHub username`,
      };
    case "GITHUB_IDENTITY_CONFLICT":
      return {
        kind: "github-conflict",
        text: `${name}: GitHub account doesn't match the recorded username`,
        plural: (n) => `${n} resources blocked by a GitHub account mismatch`,
      };
    default:
      if (b.blocker?.endsWith("_TARGET_NOT_CONFIGURED"))
        return {
          kind: "config",
          text: `${name}: target not configured`,
          plural: (n) => `${n} resources need configuration`,
        };
      // A blocker says more than the status (a READY request can still be blocked).
      return {
        kind: `other:${b.blocker ?? b.status}`,
        text: `${name}: ${b.blocker ? humanize(b.blocker) : (RESOURCE_STATUS_LABELS[b.status] ?? humanize(b.status))}`,
        plural: (n) => `${n} resources in progress`,
      };
  }
}

/** A short headline plus detail lines for a list row (null when nothing is pending). */
export function attentionSummary(
  blockers: readonly BlockerLike[],
): { tone: "amber" | "red" | "gray"; headline: string; details: string[] } | null {
  const pressing = blockers.filter(needsAttention);
  const list = pressing.length ? pressing : blockers;
  if (list.length === 0) return null;
  const issues = list.map(describeBlocker);
  const kinds = new Set(issues.map((i) => i.kind));
  const headline =
    issues.length === 1
      ? issues[0]!.text
      : kinds.size === 1
        ? issues[0]!.plural(issues.length)
        : pressing.length
          ? `${issues.length} actions required`
          : `${issues.length} resources in progress`;
  return {
    tone: pressing.some((b) => b.status === "PROVISIONING_FAILED")
      ? "red"
      : pressing.length
        ? "amber"
        : "gray",
    headline,
    details: issues.length > 1 ? issues.map((i) => i.text) : [],
  };
}

export function progressLine(w: WorkflowSummary): string {
  const p = w.resourceProgress;
  if (p.total === 0) return w.state === "COMPLETED" ? "No access requested" : "Not planned yet";
  return `${p.provisioned} of ${p.total} resources`;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: Intake → Access planning → Approval → Provisioning → Onboarding plan → Complete.

export const LIFECYCLE_STEPS = [
  "Intake",
  "Access planning",
  "Approval",
  "Provisioning",
  "Onboarding plan",
  "Complete",
] as const;

const STEP_OF: Record<string, number> = {
  RECEIVED: 0,
  ACCESS_PLANNING: 1,
  POLICY_REVIEW: 1,
  AWAITING_APPROVAL: 2,
  PROVISIONING: 3,
  ONBOARDING_GENERATION: 4,
  COMPLETED: 5,
};

export type StepStatus = "done" | "current" | "upcoming" | "skipped" | "failed";

export function lifecycle(
  view: WorkflowObservabilityView,
): { label: string; status: StepStatus }[] {
  const state = view.workflow.state;
  let current = STEP_OF[state] ?? 0;
  const failed = state === "FAILED";
  if (failed) {
    const into = [...view.timeline].reverse().find((e) => e.toState === "FAILED");
    current = STEP_OF[into?.fromState ?? "RECEIVED"] ?? 0;
  }
  const approvalNeeded =
    view.approvals.length > 0 ||
    view.policyDecisions.some((d) => d.decision === "REQUIRES_APPROVAL") ||
    view.timeline.some((e) => e.toState === "AWAITING_APPROVAL");
  return LIFECYCLE_STEPS.map((label, i) => {
    if (state === "COMPLETED") {
      return { label, status: i === 2 && !approvalNeeded ? "skipped" : "done" };
    }
    if (i < current) return { label, status: i === 2 && !approvalNeeded ? "skipped" : "done" };
    if (i === current) return { label, status: failed ? "failed" : "current" };
    return { label, status: "upcoming" };
  });
}

// ---------------------------------------------------------------------------------------------
// Timeline actors.

export type ActorKind =
  | "HR"
  | "HRIS"
  | "AI"
  | "Policy"
  | "Worker"
  | "ServiceNow"
  | "GitHub"
  | "Okta"
  | "Operator"
  | "System";

export function actorOf(e: Pick<TimelineEntry, "actor" | "type">): ActorKind {
  const actor = e.actor ?? "";
  const type = e.type;
  if (actor.startsWith("hr:")) return "HR";
  if (actor === "hris-webhook" || type.startsWith("hris.")) return "HRIS";
  if (
    type.startsWith("agent.") ||
    type.startsWith("onboarding_plan.") ||
    actor === "onboarding-plan"
  )
    return "AI";
  if (
    actor === "access-authorization" ||
    /^access\.(allowed|denied|approval_required|policy_evaluated)/.test(type)
  )
    return "Policy";
  if (
    /servicenow|approval-verifier/.test(actor) ||
    type.startsWith("servicenow.") ||
    type.startsWith("approval.")
  )
    return "ServiceNow";
  if (actor === "github-provisioning" || type.startsWith("github.")) return "GitHub";
  if (actor === "okta-provisioning" || type.startsWith("okta.")) return "Okta";
  if (type.startsWith("operator.")) return "Operator";
  if (type.startsWith("external_operation.") && !/test/.test(actor)) return "Worker";
  if (/worker|coordinator|provisioning|access-planning/.test(actor)) return "Worker";
  return "System";
}

/** Timeline wording: transitions read as "Moved to Awaiting approval". */
export function timelineSummary(e: TimelineEntry): string {
  if (e.type === "workflow.transitioned" && e.toState) return `Moved to ${stateLabel(e.toState)}`;
  if (e.type === "workflow.created") return "Workflow created";
  if (e.type === "hris.offer.signed") return "Signed offer received from HRIS";
  return e.label.replace(/\bGithub\b/g, "GitHub");
}

export const NEW_ONBOARDING_STEPS = ["Upload offer", "Review details", "Start onboarding"];

// ---------------------------------------------------------------------------------------------
// Workflow detail for HR/IT: one row per tool, who acts next, and a one-line status.

type DetailView = WorkflowObservabilityView;
export type ResourceView = DetailView["resources"][number];

export const resourceName = (id: string, displayName: string | null | undefined) =>
  displayName ?? humanize(id.replace(/-/g, "_"));

/** Who has to act next. `you` = the operator viewing the page. */
export interface Owner {
  label: string;
  you: boolean;
}

export interface ToolRow {
  resource: ResourceView;
  name: string;
  tone: Tone;
  status: string;
  owner: Owner | null;
  /** One short plain-language line about where it stands. */
  note: string | null;
  /** ServiceNow ticket number when one is involved. */
  ticket: string | null;
  /** Sort order: things needing the operator first, settled things last. */
  rank: number;
}

const YOU: Owner = { label: "You", you: true };
const ADMIN: Owner = { label: "Swift administrator", you: false };
const SWIFT: Owner = { label: "Swift (automatic)", you: false };

const isConfigBlocker = (code: string | null) =>
  code === "PROVIDER_NOT_CONFIGURED" || /_TARGET_NOT_CONFIGURED$/.test(code ?? "");

/** One resource as an HR/IT person sees it: a single status, who acts next and why. */
export function toolRow(r: ResourceView, view: DetailView): ToolRow {
  const name = resourceName(r.resourceId, r.displayName);
  const approval = [...view.approvals].reverse().find((a) => a.resourceId === r.resourceId);
  const fulfillment = view.fulfillments.find((f) => f.accessRequestId === r.accessRequestId);
  const explanation = view.policyDecisions.find((d) => d.resourceId === r.resourceId)?.explanation;
  const row = (
    tone: Tone,
    status: string,
    owner: Owner | null,
    note: string | null,
    rank: number,
    ticket: string | null = null,
  ): ToolRow => ({ resource: r, name, tone, status, owner, note, ticket, rank });

  if (r.status === "PROVISIONED")
    return row(
      "green",
      "Ready",
      null,
      r.provisionedAt ? `Ready since ${formatTime(r.provisionedAt)}` : null,
      4,
      fulfillment?.ticketNumber ?? null,
    );
  if (r.status === "DENIED")
    return row(
      "gray",
      "Not granted",
      null,
      explanation ?? "Not allowed by policy for this role.",
      5,
    );
  if (r.status === "REJECTED")
    return row(
      "gray",
      "Not granted",
      null,
      "The approver rejected this request.",
      5,
      approval?.ticketNumber ?? null,
    );
  if (r.status === "AWAITING_APPROVAL")
    return row(
      "amber",
      "Needs approval",
      { label: "Approver in ServiceNow", you: false },
      "Sensitive access: a person has to approve it before it's set up.",
      2,
      approval?.ticketNumber ?? null,
    );
  if (r.status === "MANUAL_ACTION_REQUIRED")
    return row(
      "amber",
      "Action needed",
      YOU,
      "No automatic setup for this tool: set it up, then mark it as done.",
      0,
    );
  if (r.status === "PROVISIONING_FAILED")
    return row(
      "red",
      "Failed",
      ADMIN,
      r.provisioningErrorCode === "SERVICENOW_FULFILLMENT_FAILED"
        ? "IT marked the ServiceNow request as failed."
        : `Setup failed: ${humanize(r.provisioningErrorCode ?? "unknown error").toLowerCase()}.`,
      1,
      fulfillment?.ticketNumber ?? null,
    );

  switch (r.blocker) {
    case "GITHUB_IDENTITY_CLAIM_REQUIRED":
      return row("amber", "Action needed", YOU, "Record the employee's GitHub username.", 0);
    case "GITHUB_IDENTITY_NOT_FOUND":
      return row("amber", "Action needed", YOU, "The recorded GitHub username doesn't exist.", 0);
    case "GITHUB_IDENTITY_CONFLICT":
      return row(
        "amber",
        "Action needed",
        YOU,
        "The GitHub account doesn't match the recorded username.",
        0,
      );
    case "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE":
      return row(
        "red",
        "Blocked",
        ADMIN,
        "This GitHub account is already linked to another employee.",
        1,
      );
    case "GITHUB_INVITATION_PENDING":
      return row(
        "blue",
        "Being set up",
        { label: "The employee", you: false },
        "Invitation sent: the employee has to accept it on GitHub.",
        2,
      );
    case "SERVICENOW_FULFILLMENT_PENDING":
    case "SERVICENOW_FULFILLMENT_IN_PROGRESS":
      return row(
        "blue",
        "Being set up",
        { label: "IT in ServiceNow", you: false },
        r.blocker.endsWith("IN_PROGRESS")
          ? "IT is working on the ServiceNow request."
          : "Waiting for IT to pick up the ServiceNow request.",
        2,
        fulfillment?.ticketNumber ?? null,
      );
    case "DEPENDENCIES_NOT_READY": {
      const waitingFor = r.dependsOn
        .filter((d) => d.status !== "PROVISIONED")
        .map((d) =>
          resourceName(
            d.resourceId,
            view.resources.find((x) => x.resourceId === d.resourceId)?.displayName,
          ),
        );
      return row(
        "blue",
        "Being set up",
        SWIFT,
        waitingFor.length ? `Starts after ${waitingFor.join(", ")}.` : "Starts after another tool.",
        3,
      );
    }
    case "MISSING_AUTHORIZED_DEPENDENCY":
    case "DEPENDENCY_NOT_AUTHORIZED":
      return row("red", "Blocked", ADMIN, "Needs another tool that wasn't granted.", 1);
    case "TRANSIENT_PROVIDER_FAILURE":
      return row("blue", "Being set up", SWIFT, "A provider was briefly unavailable; retrying.", 3);
  }
  if (isConfigBlocker(r.blocker))
    return row(
      "amber",
      "Blocked",
      ADMIN,
      "This tool isn't connected yet. It continues once it's configured.",
      1,
    );
  if (r.blockerClass === "DETERMINISTIC_FAILURE")
    return row("red", "Blocked", ADMIN, humanize(r.blocker ?? "Blocked") + ".", 1);
  return row("blue", "Being set up", SWIFT, null, 3);
}

/** Every resource as a row, the ones needing the operator first. */
export function toolRows(view: DetailView): ToolRow[] {
  return view.resources
    .map((r) => toolRow(r, view))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/** The one-line status under the hire's name. */
export function statusSentence(view: DetailView, rows: ToolRow[] = toolRows(view)): string {
  const state = view.workflow.state;
  if (state === "FAILED") return "This onboarding stopped.";
  if (state === "RECEIVED" || state === "ACCESS_PLANNING" || state === "POLICY_REVIEW")
    return "Working out which tools this person needs.";
  const grantable = rows.filter((r) => r.rank !== 5);
  const ready = grantable.filter((r) => r.status === "Ready").length;
  const parts = [
    grantable.length === 0
      ? "No tools to set up"
      : `${ready} of ${grantable.length} ${grantable.length === 1 ? "tool" : "tools"} ready`,
  ];
  if (state === "COMPLETED") {
    parts.unshift("Onboarding complete");
    if (view.onboardingPlan)
      parts.push(`first-month plan with ${view.onboardingPlan.taskCount} tasks`);
    return parts.join(" · ");
  }
  const you = rows.filter((r) => r.owner?.you).length;
  const others = rows.filter((r) => r.owner && !r.owner.you && r.owner !== SWIFT).length;
  if (you) parts.push(`${you} ${you === 1 ? "needs" : "need"} you`);
  if (others) parts.push(`waiting on ${others === 1 ? "1 person" : `${others} people`}`);
  if (state === "ONBOARDING_GENERATION") parts.push("writing the first-month plan");
  return parts.join(" · ");
}

/** Events a person cares about (the full record stays under Audit & technical). */
const KEY_EVENTS = new Set([
  "workflow.created",
  "workflow.transitioned",
  "offer_letter.submitted",
  "access.policy_evaluated",
  "access.approval_verified",
  "access.approval_rejected",
  "github.identity_claim_recorded",
  "github.identity_claim_changed",
  "github.org_invitation_created",
  "provisioning.manual_resource_completed",
  "resource.provisioned",
  "resource.provisioning_failed",
  "onboarding_plan.generated",
  "onboarding_plan.generation_failed",
]);

export const isKeyEvent = (e: Pick<TimelineEntry, "type">) =>
  e.type.startsWith("hris.") || KEY_EVENTS.has(e.type);

export const DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "activity", label: "Activity" },
  { id: "technical", label: "Audit & technical" },
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number]["id"];

export const detailTab = (value: unknown): DetailTab =>
  DETAIL_TABS.some((t) => t.id === value) ? (value as DetailTab) : "overview";

/** Outcome messages for "Mark as done" (fixed codes in the query string; nothing echoed). */
export const MANUAL_RESULT_MESSAGES: Record<string, { tone: Tone; text: string }> = {
  done: { tone: "green", text: "Marked as done. Swift continues automatically." },
  unchanged: { tone: "green", text: "Already marked as done." },
  INVALID_EVIDENCE: {
    tone: "red",
    text: "Describe how it was set up in 8–500 characters, without passwords or keys.",
  },
  INVALID_PAYLOAD: {
    tone: "red",
    text: "Describe how it was set up in 8–500 characters, without passwords or keys.",
  },
  NOT_AWAITING_MANUAL_ACTION: { tone: "gray", text: "This tool no longer needs manual setup." },
  MANUAL_ALREADY_COMPLETED: { tone: "gray", text: "Another operator already marked this as done." },
  ACCESS_REQUEST_NOT_FOUND: { tone: "red", text: "That tool couldn't be found." },
  INTERNAL_ERROR: { tone: "red", text: "Couldn't save. Try again." },
};
