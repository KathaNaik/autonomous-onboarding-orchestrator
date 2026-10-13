import type { StepStatus, Tone } from "./console-model";

/**
 * State for the landing page's interactive example: a synthetic onboarding the visitor steps
 * through. Pure functions (the component only renders them); no data leaves the browser.
 *
 * Steps: 0 offer signed, 1 AI suggests, 2 policy decides, 3 a person approves (full-time only),
 * 4 Swift sets up access, 5 first-month plan, 6 complete.
 */

export type Profile = "employee" | "contractor";
export type Decision = "allow" | "approval" | "deny";
export type Approval = "approved" | "rejected" | null;

export interface SimState {
  profile: Profile;
  step: number;
  approval: Approval;
}

export type SimAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "restart" }
  | { type: "decide"; approval: "approved" | "rejected" }
  | { type: "profile"; profile: Profile };

export const LAST_STEP = 6;
export const APPROVAL_STEP = 3;

/** The page opens on the approval: the visitor's first click is a decision. */
export const INITIAL_SIM: SimState = { profile: "employee", step: APPROVAL_STEP, approval: null };

export const HIRES: Record<Profile, { name: string; meta: string; label: string }> = {
  employee: {
    name: "Jordan Rivera",
    meta: "Frontend Software Engineer · Engineering, Full-time",
    label: "Full-time engineer",
  },
  contractor: {
    name: "Riley Morgan",
    meta: "Frontend Software Engineer · Engineering, Contractor",
    label: "Contractor",
  },
};

export const TOOLS = [
  { id: "github", name: "GitHub organization", confidence: 92 },
  { id: "aws-dev", name: "AWS development account", confidence: 88 },
  { id: "aws-prod", name: "AWS production account", confidence: 71 },
] as const;
export type ToolId = (typeof TOOLS)[number]["id"];

export function policy(profile: Profile, id: ToolId): { decision: Decision; why: string } {
  if (id !== "aws-prod") return { decision: "allow", why: "Engineering baseline" };
  return profile === "employee"
    ? { decision: "approval", why: "Production needs a person to approve" }
    : { decision: "deny", why: "Contractors can't access production" };
}

const needsApproval = (s: SimState) =>
  TOOLS.some((t) => policy(s.profile, t.id).decision === "approval");

export function simReducer(s: SimState, a: SimAction): SimState {
  switch (a.type) {
    case "restart":
      return { ...s, step: 0, approval: null };
    case "profile":
      // Show the policy difference straight away.
      return a.profile === s.profile ? s : { profile: a.profile, step: 2, approval: null };
    case "decide":
      return s.step === APPROVAL_STEP ? { ...s, approval: a.approval, step: 4 } : s;
    case "next": {
      if (s.step === APPROVAL_STEP || s.step >= LAST_STEP) return s; // a decision is required
      const step = s.step + 1 === APPROVAL_STEP && !needsApproval(s) ? 4 : s.step + 1;
      return { ...s, step };
    }
    case "back": {
      if (s.step === 0) return s;
      const step = s.step - 1 === APPROVAL_STEP && !needsApproval(s) ? 2 : s.step - 1;
      return { ...s, step, approval: step <= APPROVAL_STEP ? null : s.approval };
    }
  }
}

export const isGranted = (s: SimState, id: ToolId) => {
  const d = policy(s.profile, id).decision;
  return d === "allow" || (d === "approval" && s.approval === "approved");
};

export interface Cell {
  tone: Tone | null;
  label: string;
}

/** The "Policy decides" cell; null before policy has run. */
export function decisionCell(s: SimState, id: ToolId): (Cell & { why: string }) | null {
  if (s.step < 2) return null;
  const { decision, why } = policy(s.profile, id);
  if (decision === "allow") return { tone: "green", label: "Allow", why };
  if (decision === "deny") return { tone: "red", label: "Deny", why };
  if (s.approval === "approved") return { tone: "green", label: "Approved", why };
  if (s.approval === "rejected") return { tone: "red", label: "Rejected", why };
  return { tone: "amber", label: "Needs approval", why };
}

/** The "Swift sets up" cell: plain text (tone null) or a badge. */
export function executeCell(s: SimState, id: ToolId): Cell {
  const d = policy(s.profile, id).decision;
  if (s.step < APPROVAL_STEP) return { tone: null, label: "Not started" };
  if (d === "deny" || (d === "approval" && s.approval === "rejected"))
    return { tone: null, label: "Not granted" };
  if (d === "approval" && s.step === APPROVAL_STEP)
    return { tone: null, label: "Waits for approval" };
  if (s.step === APPROVAL_STEP || (s.step === 4 && id !== "github"))
    return { tone: "blue", label: "In progress" };
  return { tone: "green", label: "Ready" };
}

export const SIM_STATE: Cell[] = [
  { tone: "gray", label: "Received" },
  { tone: "blue", label: "Access planning" },
  { tone: "blue", label: "Policy review" },
  { tone: "amber", label: "Awaiting approval" },
  { tone: "blue", label: "Provisioning" },
  { tone: "blue", label: "Writing plan" },
  { tone: "green", label: "Completed" },
];

const LIFECYCLE = [
  "Intake",
  "Access planning",
  "Approval",
  "Provisioning",
  "Onboarding plan",
  "Complete",
];
const PHASE_OF = [0, 1, 1, 2, 3, 4, 5];

export function simLifecycle(s: SimState): { label: string; status: StepStatus }[] {
  const phase = PHASE_OF[s.step]!;
  return LIFECYCLE.map((label, i) => {
    if (i === 2 && !needsApproval(s) && s.step >= 2) return { label, status: "skipped" };
    if (s.step === LAST_STEP) return { label, status: "done" };
    if (i < phase) return { label, status: "done" };
    if (i === phase) return { label, status: "current" };
    return { label, status: "upcoming" };
  });
}

export function planTasks(s: SimState): string[] {
  return [
    "Sign in to GitHub and clone the frontend repositories",
    "Deploy a small change to the development account",
    isGranted(s, "aws-prod")
      ? "Review production access practices before using them"
      : "Ship a first change through code review",
  ];
}

export const NARRATION: {
  actor: "HR" | "AI" | "Policy" | "ServiceNow" | "Worker";
  actorLabel: string;
  title: string;
  text: string;
}[] = [
  {
    actor: "HR",
    actorLabel: "HR",
    title: "Offer signed",
    text: "HR confirms a signed offer for a cleared candidate. Swift starts the onboarding.",
  },
  {
    actor: "AI",
    actorLabel: "AI recommends",
    title: "AI suggests tools",
    text: "An agent reads the role and suggests tools from a fixed catalog, with its confidence. A suggestion is never a permission.",
  },
  {
    actor: "Policy",
    actorLabel: "Policy authorizes",
    title: "Policy decides each tool",
    text: "Versioned rules decide every tool on its own: allow, deny, or ask a person. The same facts always give the same answer.",
  },
  {
    actor: "ServiceNow",
    actorLabel: "ServiceNow",
    title: "Your turn: approve production access?",
    text: "Production access waits for an approver in ServiceNow, while everything else carries on. You're the approver.",
  },
  {
    actor: "Worker",
    actorLabel: "Swift executes",
    title: "Swift sets up access",
    text: "Each granted tool is set up in order and confirmed with the provider. Nothing that wasn't granted is ever touched.",
  },
  {
    actor: "AI",
    actorLabel: "AI",
    title: "First-month plan",
    text: "A second agent writes a plan for the first month, using only the tools the person actually has.",
  },
  {
    actor: "Worker",
    actorLabel: "Swift",
    title: "Ready for day one",
    text: "Every step is in the audit trail, so anyone can see what happened and why.",
  },
];
