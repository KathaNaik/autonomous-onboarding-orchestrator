import type { WorkflowObservabilityView, WorkflowSummary } from "@aoo/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowView } from "@/app/admin/onboarding/[workflowId]/workflow-view";
import { WorkflowTable } from "@/app/admin/onboarding/workflow-table";
import { humanize, toneOf } from "@/lib/dashboard-model";

import { WF, base } from "./dashboard-fixture";

describe("operator dashboard rendering", () => {
  it("renders every section of a completed workflow, readable and without mutation controls", () => {
    const html = renderToStaticMarkup(<WorkflowView view={base} />);
    for (const text of [
      "1. Overview",
      "2. Role Access Agent (recommendations: not authorization)",
      "3. Policy decisions (authorization)",
      "4. Resources and provisioning",
      "5. ServiceNow approvals and fulfillment",
      "6. External operations and identities",
      "7. Onboarding plan",
      "8. Timeline",
      "9. Trace and correlation",
      "non-employee-production-deny",
      "Denied by policy",
      "depends on <code>aws-dev</code> (not requested)",
      "Day one",
      "First week",
      "Set up MFA",
      "Workflow → COMPLETED",
      'data-state="COMPLETED"',
    ]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toMatch(/<button|<form|<input|method="post"/i);
  });

  it("renders a historical workflow with 'Not reached' / 'Not available' instead of failing", () => {
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
    expect(html).toContain("Not reached");
    expect(html).toContain("Not available (created before canonical facts)");
    expect(html).toContain("No Role Access Agent run yet (not reached).");
  });

  it("list table shows state, role summary, progress and blockers as text", () => {
    const row: WorkflowSummary = {
      workflowId: WF,
      state: "PROVISIONING",
      employee: { hrisEmployeeId: "E-1", displayName: "Grace Hopper", facts: null },
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
          status: "PROVISIONING",
          blocker: "GITHUB_INVITATION_PENDING",
          blockerClass: "WAITING",
        },
      ],
    };
    const html = renderToStaticMarkup(<WorkflowTable items={[row]} />);
    expect(html).toContain("PROVISIONING");
    expect(html).toContain("1/2 settled");
    expect(html).toContain("GITHUB_INVITATION_PENDING");
    expect(html).toContain(`/admin/onboarding/${WF}`);
    expect(toneOf("PROVISIONING_FAILED")).toBe("blocked");
    expect(humanize("PROVISIONING_FAILED")).toBe("Provisioning failed");
  });
});
