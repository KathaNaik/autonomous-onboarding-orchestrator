import type { WorkflowObservabilityView, WorkflowSummary } from "@aoo/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowView } from "@/app/admin/onboarding/[workflowId]/workflow-view";
import { WorkflowTable } from "@/app/admin/onboarding/workflow-table";
import { attentionSummary, lifecycle } from "@/lib/console-model";
import { humanize, toneOf } from "@/lib/dashboard-model";

import { WF, base } from "./dashboard-fixture";

/** Visible text only: <details> bodies (technical details) and attributes removed. */
const visible = (html: string) =>
  html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const row = (overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  workflowId: WF,
  state: "PROVISIONING",
  employee: {
    hrisEmployeeId: "E-1",
    displayName: "Grace Hopper",
    jobTitle: "Backend Software Engineer",
    facts: {
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "FULL_TIME",
    },
  },
  createdAt: base.workflow.createdAt,
  updatedAt: base.workflow.updatedAt,
  completedAt: null,
  failureReason: null,
  provisioningPlanStatus: "ACTIVE",
  onboardingPlanStatus: "NOT_STARTED",
  resourceProgress: {
    total: 2,
    settled: 1,
    provisioned: 1,
    denied: 0,
    rejected: 0,
    inProgress: 1,
    failed: 0,
  },
  blockers: [
    {
      resourceId: "github-org-membership",
      displayName: "GitHub organization membership",
      status: "PROVISIONING",
      blocker: "GITHUB_INVITATION_PENDING",
      blockerClass: "WAITING",
    },
  ],
  ...overrides,
});

describe("operator console: workflow detail", () => {
  it("explains a completed workflow: AI recommends, policy authorizes, the orchestrator executes", () => {
    const html = renderToStaticMarkup(<WorkflowView view={base} />);
    const text = visible(html);
    for (const t of [
      "Grace Hopper",
      "Backend Software Engineer",
      "Engineering, Software engineer, Contractor",
      "Role Access Agent",
      "Recommendation only — policy decides authorization.",
      "Policy decisions",
      "Deterministic authorization",
      "Contractors may not access production.",
      "Resource provisioning",
      "Denied by policy",
      "Human approval",
      "Human fulfillment",
      "Onboarding plan",
      "Day one",
      "First week",
      "Set up MFA",
      "Activity",
      "Moved to Completed",
    ]) {
      expect(text, t).toContain(t);
    }
    expect(html).toContain('data-state="COMPLETED"');
    // Raw codes and identifiers stay available, but only under technical details.
    expect(html).toContain("non-employee-production-deny");
    expect(text).not.toContain("non-employee-production-deny");
    expect(text).not.toContain("NON_EMPLOYEE_PRODUCTION_ACCESS_DENIED");
    expect(text).not.toMatch(/\bCOMPLETED\b|\bDENIED\b/);
    // Read-only: links only, no forms, buttons or inputs.
    expect(html).not.toMatch(/<button|<form|<input|method="post"/i);
  });

  it("renders a historical workflow with 'Not reached yet' instead of failing", () => {
    const legacy: WorkflowObservabilityView = {
      ...base,
      workflow: { ...base.workflow, state: "RECEIVED", completedAt: null },
      employee: { ...base.employee, facts: null, jobTitle: null, factsSourceEventId: null },
      hrisEvents: [],
      roleAccessRun: null,
      policyDecisions: [],
      resources: [],
      onboardingPlan: null,
      timeline: [],
      notes: ["No Role Access Agent run yet (not reached)."],
    };
    const html = renderToStaticMarkup(<WorkflowView view={legacy} />);
    expect(visible(html)).toContain("Not reached yet");
    expect(visible(html)).toContain(
      "Canonical facts not available (created before canonical facts)",
    );
    expect(html).toContain("No Role Access Agent run yet (not reached).");
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Intake/);
  });

  it("puts a required operator action in a callout with a clear link", () => {
    const waiting: WorkflowObservabilityView = {
      ...base,
      workflow: { ...base.workflow, state: "PROVISIONING", completedAt: null },
      resources: [
        {
          ...base.resources[0]!,
          resourceId: "github-org-membership",
          displayName: "GitHub organization membership",
          provider: "GITHUB",
          authorization: { decision: "ALLOW", outcome: "AUTHORIZED_BY_POLICY", via: "POLICY" },
          status: "READY_FOR_PROVISIONING",
          settled: false,
          dependsOn: [],
          blocker: "GITHUB_IDENTITY_CLAIM_REQUIRED",
          blockerClass: "WAITING",
        },
      ],
    };
    const html = renderToStaticMarkup(<WorkflowView view={waiting} />);
    expect(visible(html)).toContain("GitHub identity required");
    expect(visible(html)).toContain(
      "Provisioning is waiting for HR to record the employee's GitHub username",
    );
    expect(html).toContain(`href="/admin/onboarding/${WF}/github"`);
    expect(visible(html)).toContain("Record GitHub username");
    expect(visible(html)).not.toContain("GITHUB_IDENTITY_CLAIM_REQUIRED");
  });

  it("lifecycle: approval is the current step while waiting, and 'not needed' when policy never asked", () => {
    const awaiting = lifecycle({
      ...base,
      workflow: { ...base.workflow, state: "AWAITING_APPROVAL" },
    });
    expect(awaiting.find((s) => s.status === "current")?.label).toBe("Approval");
    const done = lifecycle(base); // completed, no approval required
    expect(done.find((s) => s.label === "Approval")?.status).toBe("skipped");
    expect(done.filter((s) => s.status === "done")).toHaveLength(5);
  });
});

describe("operator console: workflow list", () => {
  it("leads with the employee and plain-language status, never raw blocker codes", () => {
    const html = renderToStaticMarkup(<WorkflowTable items={[row()]} />);
    const text = visible(html);
    for (const t of [
      "Grace Hopper",
      "Backend Software Engineer",
      "Engineering, Software engineer, Full-time",
      "Provisioning",
      "1 of 2 resources",
      "GitHub invitation not accepted yet",
      "View",
    ]) {
      expect(text, t).toContain(t);
    }
    expect(html).not.toContain("GITHUB_INVITATION_PENDING");
    expect(html).toContain(`/admin/onboarding/${WF}`);
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*>Employee<\/th>/);
  });

  it("summarizes attention needs in operator terms", () => {
    const b = (
      resourceId: string,
      status: string,
      blocker: string | null,
      displayName: string,
    ) => ({
      resourceId,
      displayName,
      status,
      blocker,
      blockerClass: null,
    });
    expect(
      attentionSummary([
        b(
          "github-org-membership",
          "READY_FOR_PROVISIONING",
          "GITHUB_IDENTITY_CLAIM_REQUIRED",
          "GitHub org",
        ),
      ])?.headline,
    ).toBe("GitHub username required");
    const owned = attentionSummary([
      b(
        "github-org-membership",
        "READY_FOR_PROVISIONING",
        "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE",
        "GitHub engineering organization",
      ),
    ]);
    expect(owned?.headline).toBe(
      "GitHub engineering organization: GitHub account already linked to another employee",
    );
    expect(JSON.stringify(owned)).not.toContain("Ready");
    expect(
      attentionSummary([b("okta", "READY_FOR_PROVISIONING", "SOME_NEW_BLOCKER", "Okta group")])
        ?.headline,
    ).toBe("Okta group: Some new blocker");
    expect(
      attentionSummary([
        b("aws-dev", "PROVISIONING", "SERVICENOW_FULFILLMENT_PENDING", "AWS dev"),
        b("slack", "PROVISIONING", "SERVICENOW_FULFILLMENT_PENDING", "Slack"),
      ])?.headline,
    ).toBe("2 fulfillments pending");
    expect(
      attentionSummary([
        b("aws-prod", "AWAITING_APPROVAL", "AWAITING_APPROVAL", "AWS production account"),
      ])?.headline,
    ).toBe("AWS production account approval");
    const mixed = attentionSummary([
      b("aws-prod", "AWAITING_APPROVAL", null, "AWS production"),
      b("cursor", "MANUAL_ACTION_REQUIRED", "MANUAL_ACTION_REQUIRED", "Cursor"),
      b("team", "READY_FOR_PROVISIONING", "DEPENDENCIES_NOT_READY", "Team"),
    ]);
    expect(mixed?.headline).toBe("2 actions required");
    expect(mixed?.tone).toBe("amber");
    expect(attentionSummary([])).toBeNull();
    // Waiting on dependencies alone isn't an action: shown quietly.
    expect(
      attentionSummary([b("team", "READY_FOR_PROVISIONING", "DEPENDENCIES_NOT_READY", "Team")])
        ?.tone,
    ).toBe("gray");
  });

  it("an empty list invites the operator to start one", () => {
    expect(visible(renderToStaticMarkup(<WorkflowTable items={[]} />))).toContain(
      "No workflows match. Start one from a signed offer letter.",
    );
    // The public demo keeps its own helpers.
    expect(toneOf("PROVISIONING_FAILED")).toBe("blocked");
    expect(humanize("PROVISIONING_FAILED")).toBe("Provisioning failed");
  });
});
