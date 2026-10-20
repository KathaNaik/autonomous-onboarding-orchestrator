import type { WorkflowObservabilityView } from "@aoo/shared";
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDuration,
  oktaAccount,
  onboardingTiming,
  toolDuration,
} from "@/lib/console-model";
import { base } from "./dashboard-fixture";

/** (M14) Start date, time to access and the Okta login on the workflow page. */
const settledAt = "2026-10-01T02:14:00.000Z";
const view = (over: Partial<WorkflowObservabilityView> = {}): WorkflowObservabilityView => ({
  ...base,
  workflow: { ...base.workflow, createdAt: "2026-10-01T00:00:00.000Z", completedAt: null },
  employee: { ...base.employee, startDate: "2026-10-12" },
  timeline: [
    ...base.timeline.filter((e) => e.toState !== "COMPLETED"),
    {
      id: "audit:s",
      source: "AUDIT",
      occurredAt: settledAt,
      type: "workflow.transitioned",
      label: "Workflow → ONBOARDING_GENERATION",
      actor: "provisioning",
      fromState: "PROVISIONING",
      toState: "ONBOARDING_GENERATION",
      details: {},
    },
  ],
  ...over,
});

describe("onboarding timing", () => {
  it("formats durations and calendar dates", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(4 * 60_000)).toBe("4 min");
    expect(formatDuration((2 * 60 + 14) * 60_000)).toBe("2 h 14 min");
    expect(formatDuration(26 * 3_600_000)).toBe("1 day 2 h");
    expect(formatDate("2026-10-12")).toBe("Mon, Oct 12, 2026");
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("time to access, start-date countdown and readiness", () => {
    const t = onboardingTiming(view(), new Date("2026-10-03T12:00:00Z"));
    expect(t).toMatchObject({
      startDate: "2026-10-12",
      startRelative: "Starts in 9 days",
      accessReadyAt: settledAt,
      accessDuration: "2 h 14 min",
      elapsed: null,
      totalDuration: null,
      readiness: { tone: "green", text: "Access ready 11 days before the start date" },
    });
  });

  it("while in progress: elapsed time and days left; late start dates are flagged", () => {
    const running = view({ timeline: base.timeline.filter((e) => e.toState !== "COMPLETED") });
    const t = onboardingTiming(
      { ...running, workflow: { ...running.workflow, state: "PROVISIONING" } },
      new Date("2026-10-04T00:00:00Z"),
    );
    expect(t.accessDuration).toBeNull();
    expect(t.elapsed).toBe("3 days");
    expect(t.readiness).toEqual({ tone: "blue", text: "8 days left to finish setting up access" });
    const late = onboardingTiming(
      { ...running, workflow: { ...running.workflow, state: "PROVISIONING" } },
      new Date("2026-10-13T00:00:00Z"),
    );
    expect(late.startRelative).toBe("Started 1 day ago");
    expect(late.readiness?.tone).toBe("red");
  });

  it("no start date recorded: nothing invented", () => {
    const t = onboardingTiming(view({ employee: { ...base.employee, startDate: null } }));
    expect([t.startDate, t.startRelative, t.readiness]).toEqual([null, null, null]);
  });

  it("per-tool time from the onboarding start", () => {
    const v = view();
    const r = {
      ...v.resources[0]!,
      status: "PROVISIONED" as const,
      provisionedAt: "2026-10-01T00:04:00.000Z",
    };
    expect(toolDuration(r, v)).toBe("4 min");
  });

  it("Okta login: the identity's login, staged when Swift created it", () => {
    const identities = [
      {
        provider: "okta",
        providerSubjectId: "00u1",
        login: "grace@example.com",
        linkedAt: settledAt,
        verifiedAt: settledAt,
      },
    ];
    expect(oktaAccount(view())).toBeNull();
    const created = view({
      identities,
      timeline: [
        ...view().timeline,
        { ...view().timeline[0]!, id: "audit:o", type: "okta.identity_created" },
      ],
    });
    expect(oktaAccount(created)).toMatchObject({ login: "grace@example.com" });
    const note = oktaAccount(created)!.note;
    expect(note).toMatch(/Status: STAGED/);
    expect(note).toMatch(/does not activate the account/);
    expect(note).toMatch(/does not set a password/);
    expect(oktaAccount(view({ identities }))!.note).toMatch(/existing Okta account/);
  });
});
