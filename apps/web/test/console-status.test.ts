import { describe, expect, it } from "vitest";
import {
  formatAge,
  progressLine,
  startDatePassed,
  timelineSummary,
  toolRows,
  workflowBadge,
} from "@/lib/console-model";
import { base } from "./dashboard-fixture";

type View = typeof base;
const res = (over: Partial<View["resources"][number]>) => ({ ...base.resources[0]!, ...over });

describe("console status is honest and consistent", () => {
  it("the badge says Blocked or Late instead of the phase name", () => {
    expect(workflowBadge("PROVISIONING", { blocked: true, late: true }).label).toBe("Blocked");
    expect(workflowBadge("PROVISIONING", { blocked: false, late: true }).label).toBe("Late");
    expect(workflowBadge("PROVISIONING", { blocked: false, late: false }).label).toBe(
      "Setting up access",
    );
    expect(workflowBadge("COMPLETED", { blocked: true, late: true }).label).toBe("Completed");
    expect(startDatePassed("2020-01-01")).toBe(true);
    expect(startDatePassed("2999-01-01")).toBe(false);
    expect(startDatePassed(null)).toBe(false);
  });

  it("the list counts tools like the detail page: not-granted tools are left out", () => {
    const w = {
      state: "PROVISIONING",
      resourceProgress: {
        total: 6,
        settled: 4,
        provisioned: 3,
        denied: 1,
        rejected: 0,
        inProgress: 2,
        failed: 0,
      },
    } as Parameters<typeof progressLine>[0];
    expect(progressLine(w)).toBe("3 of 5 tools ready");
  });

  it("a tool waiting on a stuck tool says so and hands the next step to that tool", () => {
    const view: View = {
      ...base,
      workflow: { ...base.workflow, state: "PROVISIONING", completedAt: null },
      resources: [
        res({
          accessRequestId: "a1d8a2b0-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "github-org-membership",
          displayName: "GitHub organization",
          provider: "GITHUB",
          status: "READY_FOR_PROVISIONING",
          settled: false,
          dependsOn: [],
          blocker: "GITHUB_IDENTITY_OWNED_BY_OTHER_EMPLOYEE",
          blockerClass: "DETERMINISTIC_FAILURE",
        }),
        res({
          accessRequestId: "b1d8a2b0-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
          resourceId: "github-team-backend",
          displayName: "GitHub backend team",
          provider: "GITHUB",
          status: "READY_FOR_PROVISIONING",
          settled: false,
          dependsOn: [{ resourceId: "github-org-membership", status: "READY_FOR_PROVISIONING" }],
          blocker: "DEPENDENCIES_NOT_READY",
          blockerClass: "WAITING",
        }),
      ],
    };
    const [org, team] = toolRows(view);
    expect(org).toMatchObject({ status: "Action needed", owner: { you: true } });
    expect(org!.note).toMatch(/Ask the employee for their own GitHub username/);
    expect(team).toMatchObject({ status: "Waiting", owner: null });
    expect(team!.note).toBe("Waiting on GitHub organization (action needed, next step by you).");
  });

  it("activity reads in the operator's language and dates use one format", () => {
    const names = new Map([["slack-engineering", "Slack engineering channels"]]);
    const e = {
      ...base.timeline[0]!,
      type: "resource.provisioned",
      details: { resourceId: "slack-engineering" },
    };
    expect(timelineSummary(e, names)).toBe("Slack engineering channels is ready");
    expect(timelineSummary({ ...base.timeline[0]!, actor: "hr:op@example.com" })).toBe(
      "Offer letter confirmed by an operator",
    );
    expect(timelineSummary({ ...base.timeline[1]!, toState: "PROVISIONING" })).toBe(
      "Setting up access",
    );
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(formatAge("2026-11-18T11:00:00Z", now)).toBe("1 h ago");
    expect(formatAge("2026-10-20T07:21:00Z", now)).toBe("Oct 20, 2026");
    expect(formatAge("2026-10-06T07:21:00Z", now)).toBe("Oct 6, 2026");
  });
});
