import { describe, expect, it } from "vitest";
import {
  authorizationOutcome,
  currentPlan,
  decodeCursor,
  encodeCursor,
  onboardingPlanStatus,
  resourceProgress,
  safeDetails,
  safeText,
  sortTimeline,
  timelineLabel,
} from "../src/index.js";

describe("M9 read-model building blocks", () => {
  it("copies only whitelisted scalar details, scrubbed", () => {
    expect(
      safeDetails({
        resourceId: "aws-dev",
        decision: "ALLOW",
        attempt: 2,
        retryable: false,
        reason: "HTTP 401 Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        authorization: "Bearer x",
        password: "hunter2",
        rawBody: { a: 1 },
        nested: { resourceId: "x" },
        teamId: 19730728,
      }),
    ).toEqual({
      resourceId: "aws-dev",
      decision: "ALLOW",
      attempt: 2,
      retryable: false,
      reason: expect.not.stringContaining("abcdefghijklmnopqrstuvwxyz"),
      teamId: 19730728,
    });
    expect(safeDetails(null)).toEqual({});
    expect(safeDetails(["resourceId"])).toEqual({});
    expect(safeText("x".repeat(400), 50)).toHaveLength(50);
    expect(safeText(undefined)).toBeNull();
  });

  it("orders the timeline by microsecond time, then stable id (not insertion order)", () => {
    const e = (id: string, us: bigint) => ({ id, occurredAtUs: us });
    const sorted = sortTimeline([
      e("audit:c", 5n),
      e("audit:b", 5n),
      e("hris:a", 9n),
      e("audit:z", 1n),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["audit:z", "audit:b", "audit:c", "hris:a"]);
    expect(sortTimeline([...sorted].reverse())).toEqual(sorted);
  });

  it("labels known events and humanizes unknown ones", () => {
    expect(timelineLabel("resource.provisioned")).toBe("Resource provisioned");
    expect(timelineLabel("workflow.transitioned", "COMPLETED")).toBe("Workflow → COMPLETED");
    expect(timelineLabel("legacy.some_event")).toBe("Legacy some event");
  });

  it("keeps authorization separate from provisioning status", () => {
    expect(authorizationOutcome("ALLOW", "PROVISIONING_FAILED", "POLICY")).toBe(
      "AUTHORIZED_BY_POLICY",
    );
    expect(authorizationOutcome("DENY", "DENIED", null)).toBe("DENIED_BY_POLICY");
    expect(authorizationOutcome("REQUIRES_APPROVAL", "AWAITING_APPROVAL", null)).toBe(
      "PENDING_APPROVAL",
    );
    expect(authorizationOutcome("REQUIRES_APPROVAL", "REJECTED", null)).toBe(
      "REJECTED_BY_APPROVER",
    );
    expect(authorizationOutcome("REQUIRES_APPROVAL", "PROVISIONED", "APPROVAL")).toBe(
      "AUTHORIZED_BY_APPROVAL",
    );
  });

  it("summarizes resource progress", () => {
    expect(
      resourceProgress([
        "PROVISIONED",
        "DENIED",
        "REJECTED",
        "PROVISIONING",
        "AWAITING_APPROVAL",
        "PROVISIONING_FAILED",
      ]),
    ).toEqual({
      total: 6,
      settled: 3,
      provisioned: 1,
      denied: 1,
      rejected: 1,
      inProgress: 2,
      failed: 1,
    });
    expect(resourceProgress([])).toMatchObject({ total: 0, settled: 0 });
  });

  it("follows the ACTIVE plan, else the latest completed one", () => {
    const p = (status: "ACTIVE" | "COMPLETE", t: number) => ({ status, createdAt: new Date(t) });
    expect(currentPlan([p("COMPLETE", 1), p("ACTIVE", 0)])!.status).toBe("ACTIVE");
    expect(currentPlan([p("COMPLETE", 1), p("COMPLETE", 5)])!.createdAt.getTime()).toBe(5);
    expect(currentPlan([])).toBeNull();
  });

  it("derives the onboarding-plan status", () => {
    expect(onboardingPlanStatus(true, [])).toBe("ACCEPTED");
    expect(onboardingPlanStatus(false, [{ status: "FAILED", errorRetryable: false }])).toBe(
      "FAILED",
    );
    expect(onboardingPlanStatus(false, [{ status: "FAILED", errorRetryable: true }])).toBe(
      "GENERATING",
    );
    expect(onboardingPlanStatus(false, [])).toBe("NOT_STARTED");
  });

  it("round-trips an opaque cursor and rejects garbage", () => {
    const c = encodeCursor("2026-09-30 10:00:00.123456+00", "3f1c2b9a-1d2e-4f5a-9b8c-7d6e5f4a3b2c");
    expect(decodeCursor(c)).toEqual({
      u: "2026-09-30 10:00:00.123456+00",
      i: "3f1c2b9a-1d2e-4f5a-9b8c-7d6e5f4a3b2c",
    });
    for (const bad of ["x", Buffer.from('{"u":"not a date","i":"x"}').toString("base64url"), ""]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
