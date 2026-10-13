import { lifecycleSteps, type ActorKind, type Owner, type Tone } from "./console-model";
import type { DemoScenario } from "./demo-data";

/**
 * Presentation for the public demo, mirroring the operator workflow page (one row per tool, who
 * acts next, one status sentence) from the stricter, identifier-free demo model. Pure; no I/O.
 */

type DemoResource = DemoScenario["resources"][number];

export interface DemoToolRow {
  resource: DemoResource;
  tone: Tone;
  status: string;
  owner: Owner | null;
  note: string;
  rank: number;
}

const SWIFT: Owner = { label: "Swift (automatic)", you: false };

/** What actually happened for a tool that is ready (never a generic "verified"). */
function readyNote(r: DemoResource): string {
  if (r.provider === "OKTA") return "Added in Okta and confirmed.";
  if (r.provider === "GITHUB") return "Membership active in GitHub.";
  if (r.provider === "MANUAL") return "Set up by the HR or IT operator.";
  return r.decision === "REQUIRES_APPROVAL"
    ? "Approved in ServiceNow, then set up by IT."
    : "Set up by IT through ServiceNow.";
}

/** The "Why" lines for a tool: what the AI did and what the access rules decided. */
export function demoWhy(r: DemoResource): string[] {
  const rule =
    r.decision === "ALLOW"
      ? "Access rules: allowed."
      : r.decision === "DENY"
        ? "Access rules: refused."
        : "Access rules: needs an approver.";
  return ["Suggested by the AI for this role.", `${rule} ${r.reason}`];
}

export function demoToolRow(r: DemoResource, all: readonly DemoResource[]): DemoToolRow {
  const row = (tone: Tone, status: string, owner: Owner | null, note: string, rank: number) => ({
    resource: r,
    tone,
    status,
    owner,
    note,
    rank,
  });
  switch (r.status) {
    case "PROVISIONED":
      return row("green", "Ready", null, readyNote(r), 4);
    case "DENIED":
      return row("gray", "Not granted", null, r.reason, 5);
    case "REJECTED":
      return row("gray", "Not granted", null, "The approver rejected this request.", 5);
    case "AWAITING_APPROVAL":
      return row(
        "amber",
        "Needs approval",
        { label: "Approver in ServiceNow", you: false },
        "Sensitive access: a person has to approve it before it's set up.",
        2,
      );
    case "MANUAL_ACTION_REQUIRED":
      return row(
        "amber",
        "Action needed",
        { label: "HR / IT operator", you: true },
        "No automatic setup for this tool: the operator sets it up, then marks it as done.",
        0,
      );
  }
  const waitingFor = r.dependsOn
    .map((id) => all.find((x) => x.resourceId === id))
    .filter((d) => d && d.status !== "PROVISIONED")
    .map((d) => d!.displayName);
  if (waitingFor.length)
    return row("blue", "Being set up", SWIFT, `Starts after ${waitingFor.join(", ")}.`, 3);
  if (r.provider === "GITHUB" && r.status === "PROVISIONING")
    return row(
      "blue",
      "Being set up",
      { label: "The employee", you: false },
      "Invitation sent: the employee has to accept it on GitHub.",
      2,
    );
  if (r.provider === "SERVICENOW")
    return row(
      "blue",
      "Being set up",
      { label: "IT in ServiceNow", you: false },
      "Waiting for IT to complete the ServiceNow request.",
      2,
    );
  return row("blue", "Being set up", SWIFT, r.waitingOn ?? "Being set up automatically.", 3);
}

export function demoToolRows(s: DemoScenario): DemoToolRow[] {
  return s.resources
    .map((r) => demoToolRow(r, s.resources))
    .sort(
      (a, b) => a.rank - b.rank || a.resource.displayName.localeCompare(b.resource.displayName),
    );
}

export function demoStatusSentence(s: DemoScenario, rows: DemoToolRow[]): string {
  const grantable = rows.filter((r) => r.rank !== 5);
  const ready = grantable.filter((r) => r.status === "Ready").length;
  const parts = [
    `${ready} of ${grantable.length} ${grantable.length === 1 ? "tool" : "tools"} ready`,
  ];
  if (s.state === "COMPLETED") {
    parts.unshift("Onboarding complete");
    if (s.plan) parts.push(`first-month plan with ${s.plan.tasks.length} tasks`);
    return parts.join(" · ");
  }
  const others = rows.filter((r) => r.owner && r.owner !== SWIFT && !r.owner.you).length;
  if (others) parts.push(`waiting on ${others === 1 ? "1 person" : `${others} people`}`);
  return parts.join(" · ");
}

export const demoLifecycle = (s: DemoScenario) =>
  lifecycleSteps(s.state, {
    approvalNeeded: s.resources.some((r) => r.decision === "REQUIRES_APPROVAL"),
  });

/** Demo timeline actors (free text in the bundled data) → the console's actor chips. */
export function demoActor(actor: string): ActorKind {
  if (actor === "HR system") return "HRIS";
  if (actor === "HR") return "HR";
  if (actor === "AI") return "AI";
  if (actor === "Access rules") return "Policy";
  if (actor === "Approver" || actor === "IT") return "ServiceNow";
  if (actor === "Swift") return "Worker";
  return "System";
}

export const DECISION_TONE: Record<DemoResource["decision"], Tone> = {
  ALLOW: "green",
  REQUIRES_APPROVAL: "amber",
  DENY: "red",
};
