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
  it("overview: the hire, one status line, what needs you and one row per tool", () => {
    const html = renderToStaticMarkup(<WorkflowView view={base} />);
    const text = visible(html);
    for (const t of [
      "Grace Hopper",
      "Backend Software Engineer",
      "Engineering, Software engineer, Contractor",
      "Onboarding complete · No tools to set up",
      "Needs your attention",
      "Onboarding complete. Nothing left to do.",
      "Tools and access",
      "Not granted",
      "Contractors may not access production.",
      "Overview",
      "Plan",
      "Audit & technical",
    ]) {
      expect(text, t).toContain(t);
    }
    expect(html).toContain('data-state="COMPLETED"');
    expect(html).toMatch(/aria-current="page"[^>]*>Overview/);
    // The system's internals live under "Audit & technical", not on the overview.
    for (const t of ["Role Access Agent", "Policy decisions", "Human fulfillment", "Provenance"]) {
      expect(text, t).not.toContain(t);
    }
    expect(html).not.toContain("non-employee-production-deny");
    expect(text).not.toContain(WF); // the workflow id is technical detail (links only)
    expect(text).not.toMatch(/\bCOMPLETED\b|\bDENIED\b/);
    // Nothing to do here, so no forms.
    expect(html).not.toMatch(/<form|<textarea|method="post"/i);
  });

  it("plan, activity and audit tabs", () => {
    const plan = visible(renderToStaticMarkup(<WorkflowView view={base} tab="plan" />));
    for (const t of ["A practical first month.", "Day one", "First week", "Set up MFA"])
      expect(plan, t).toContain(t);
    expect(plan).not.toContain("Tools and access");

    const activity = visible(renderToStaticMarkup(<WorkflowView view={base} tab="activity" />));
    expect(activity).toContain("Signed offer received from HRIS");
    expect(activity).toContain("Moved to Completed");

    const html = renderToStaticMarkup(<WorkflowView view={base} tab="technical" />);
    const tech = visible(html);
    for (const t of [
      "Role Access Agent",
      "Recommendation only — policy decides authorization.",
      "Policy decisions",
      "Contractors may not access production.",
      "Resource provisioning",
      "Denied by policy",
      "Human approval",
      "Human fulfillment",
      "Onboarding Plan Agent",
      "Full activity record",
      "Provenance",
    ]) {
      expect(tech, t).toContain(t);
    }
    // Raw codes and identifiers stay available, behind disclosures.
    expect(html).toContain("non-employee-production-deny");
    expect(html).toContain(WF);
    expect(tech).not.toContain("non-employee-production-deny");
    expect(html).not.toMatch(/<form|<input|method="post"/i);
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
    expect(visible(html)).toContain("Department and role not recorded");
    expect(visible(html)).toContain("Working out which tools this person needs.");
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Intake/);
    expect(visible(renderToStaticMarkup(<WorkflowView view={legacy} tab="plan" />))).toContain(
      "Not reached yet",
    );
    expect(renderToStaticMarkup(<WorkflowView view={legacy} tab="technical" />)).toContain(
      "No Role Access Agent run yet (not reached).",
    );
  });

  const resource = (o: Partial<WorkflowObservabilityView["resources"][number]>) => ({
    ...base.resources[0]!,
    authorization: { decision: "ALLOW", outcome: "AUTHORIZED_BY_POLICY", via: "POLICY" } as const,
    settled: false,
    dependsOn: [],
    ...o,
  });

  it("a GitHub username to record is a to-do with a clear link", () => {
    const waiting: WorkflowObservabilityView = {
      ...base,
      workflow: { ...base.workflow, state: "PROVISIONING", completedAt: null },
      onboardingPlan: null,
      resources: [
        resource({
          resourceId: "github-org-membership",
          displayName: "GitHub organization membership",
          provider: "GITHUB",
          status: "READY_FOR_PROVISIONING",
          blocker: "GITHUB_IDENTITY_CLAIM_REQUIRED",
          blockerClass: "WAITING",
        }),
      ],
    };
    const html = renderToStaticMarkup(<WorkflowView view={waiting} />);
    const text = visible(html);
    expect(text).toContain("0 of 1 tool ready · 1 needs you");
    expect(text).toContain("Record the employee's GitHub username");
    expect(text).toContain("Needed before Swift can set up GitHub organization membership.");
    expect(html).toContain(`href="/admin/onboarding/${WF}/github"`);
    expect(text).toContain("Record GitHub username");
    expect(text).not.toContain("GITHUB_IDENTITY_CLAIM_REQUIRED");
    expect(text).not.toContain("Ready");
  });

  it("a MANUAL tool gets a 'Mark as done' form; approvals and fulfillment show who they wait on", () => {
    const view: WorkflowObservabilityView = {
      ...base,
      workflow: { ...base.workflow, state: "AWAITING_APPROVAL", completedAt: null },
      onboardingPlan: null,
      resources: [
        resource({
          accessRequestId: "5f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "cursor-license",
          displayName: "Cursor license",
          provider: "MANUAL",
          status: "MANUAL_ACTION_REQUIRED",
          blocker: "MANUAL_ACTION_REQUIRED",
          blockerClass: "MANUAL",
        }),
        resource({
          accessRequestId: "6f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "aws-prod",
          displayName: "AWS production account",
          authorization: { decision: "REQUIRES_APPROVAL", outcome: "PENDING_APPROVAL", via: null },
          status: "AWAITING_APPROVAL",
          blocker: "AWAITING_APPROVAL",
          blockerClass: "WAITING",
        }),
        resource({
          accessRequestId: "7f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "aws-dev",
          displayName: "AWS development account",
          status: "PROVISIONING",
          blocker: "SERVICENOW_FULFILLMENT_PENDING",
          blockerClass: "WAITING",
        }),
      ],
      approvals: [
        {
          ...({} as WorkflowObservabilityView["approvals"][number]),
          approvalId: "8f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "aws-prod",
          ticketNumber: "OAR0001030",
          status: "PENDING",
          decidedAt: null,
        },
      ],
      fulfillments: [
        {
          ...({} as WorkflowObservabilityView["fulfillments"][number]),
          accessRequestId: "7f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "aws-dev",
          ticketNumber: "OAR0001031",
        },
      ],
    };
    const html = renderToStaticMarkup(<WorkflowView view={view} />);
    const text = visible(html);
    expect(text).toContain("0 of 3 tools ready · 1 needs you · waiting on 2 people");
    expect(text).toContain("Set up Cursor license");
    expect(html).toContain(
      `action="/admin/onboarding/${WF}/resources/5f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c/complete"`,
    );
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toMatch(/<textarea[^>]*name="evidence"[^>]*required/);
    expect(html).toMatch(/<label[^>]*for="evidence-5f1d8a2b[^"]*"[^>]*>How was it set up\?/);
    expect(text).toContain("Mark as done");
    expect(text).toContain(
      "Waiting on others: AWS development account (IT in ServiceNow, OAR0001031); AWS production account (Approver in ServiceNow, OAR0001030)",
    );
    // The tool needing the operator is listed first.
    expect(text.indexOf("Cursor license")).toBeLessThan(text.indexOf("AWS production account"));

    const saved = visible(renderToStaticMarkup(<WorkflowView view={view} result="done" />));
    expect(saved).toContain("Marked as done. Swift continues automatically.");
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
