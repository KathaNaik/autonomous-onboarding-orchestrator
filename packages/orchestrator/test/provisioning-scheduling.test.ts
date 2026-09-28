import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKERS,
  classifyDispatchError,
  completionState,
  dependencyState,
  dispatchKind,
  isSettled,
  statusBlocker,
  topologicalOrder,
  type RequestStatus,
} from "../src/provisioning/scheduling.js";

const node = (resourceId: string, status: RequestStatus, dependsOn: string[] = []) => ({
  resourceId,
  status,
  dependsOn,
});

describe("dependency graph and topological order", () => {
  it("orders dependencies first, ties by id, whatever the input order", () => {
    const nodes = [
      node("github-team-backend", "READY_FOR_PROVISIONING", ["github-org-membership"]),
      node("okta-engineering-group", "READY_FOR_PROVISIONING"),
      node("github-org-membership", "READY_FOR_PROVISIONING"),
      node("aws-prod", "READY_FOR_PROVISIONING", ["aws-dev"]),
      node("aws-dev", "READY_FOR_PROVISIONING"),
    ];
    const ids = (ns: typeof nodes) => topologicalOrder(ns).map((n) => n.resourceId);
    expect(ids(nodes)).toEqual([
      "aws-dev",
      "aws-prod",
      "github-org-membership",
      "github-team-backend",
      "okta-engineering-group",
    ]);
    expect(ids([...nodes].reverse())).toEqual(ids(nodes));
  });

  it("ignores edges to resources outside the plan (reported separately) and rejects cycles", () => {
    expect(topologicalOrder([node("team", "READY_FOR_PROVISIONING", ["org"])])).toHaveLength(1);
    expect(() =>
      topologicalOrder([
        node("a", "READY_FOR_PROVISIONING", ["b"]),
        node("b", "READY_FOR_PROVISIONING", ["a"]),
      ]),
    ).toThrow(/cycle/);
  });

  it("satisfies a dependency only when the plan's request for it is PROVISIONED", () => {
    const team = node("team", "READY_FOR_PROVISIONING", ["org"]);
    const at = (status?: RequestStatus) =>
      dependencyState(team, new Map(status ? [["org", status]] : []));
    expect(at()).toEqual({ kind: "MISSING", missing: ["org"] });
    expect(at("DENIED")).toEqual({ kind: "UNSATISFIABLE", blocked: ["org"] });
    expect(at("REJECTED")).toEqual({ kind: "UNSATISFIABLE", blocked: ["org"] });
    for (const s of [
      "READY_FOR_PROVISIONING",
      "PROVISIONING",
      "AWAITING_APPROVAL",
      "PROVISIONING_FAILED",
      "MANUAL_ACTION_REQUIRED",
    ] as const) {
      expect(at(s)).toEqual({ kind: "WAITING", pending: ["org"] });
    }
    expect(at("PROVISIONED")).toEqual({ kind: "SATISFIED" });
    expect(dependencyState(node("x", "READY_FOR_PROVISIONING"), new Map())).toEqual({
      kind: "SATISFIED",
    });
  });
});

describe("provider dispatch and blockers", () => {
  it("dispatches only OKTA, GITHUB and MANUAL; everything else is unsupported, never MANUAL", () => {
    expect(["OKTA", "GITHUB", "MANUAL"].map(dispatchKind)).toEqual(["OKTA", "GITHUB", "MANUAL"]);
    expect(["SERVICENOW", "NONE", "AWS", ""].map(dispatchKind)).toEqual([
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
    ]);
  });

  it("classifies provider errors: human waits event-driven, transient scheduled, the rest deterministic", () => {
    expect(
      classifyDispatchError({ code: "GITHUB_IDENTITY_CLAIM_REQUIRED", retryable: true }),
    ).toEqual(BLOCKERS.GITHUB_IDENTITY_CLAIM_REQUIRED);
    expect(BLOCKERS.GITHUB_IDENTITY_CLAIM_REQUIRED.schedule).toBe("NONE");
    expect(classifyDispatchError({ code: "RETRY_LATER", retryable: true })).toEqual(
      BLOCKERS.TRANSIENT_PROVIDER_FAILURE,
    );
    expect(BLOCKERS.TRANSIENT_PROVIDER_FAILURE).toMatchObject({
      blockerClass: "RETRYABLE",
      schedule: "RETRY",
    });
    expect(classifyDispatchError({ code: "PROVISIONING_FAILED", retryable: false })).toEqual(
      BLOCKERS.PROVISIONING_FAILED,
    );
    expect(classifyDispatchError({ code: "OKTA_TARGET_NOT_CONFIGURED", retryable: false })).toEqual(
      {
        code: "OKTA_TARGET_NOT_CONFIGURED",
        blockerClass: "DETERMINISTIC_FAILURE",
        schedule: "NONE",
      },
    );
    expect(BLOCKERS.GITHUB_INVITATION_PENDING).toMatchObject({
      blockerClass: "WAITING",
      schedule: "RECONCILE",
    });
    expect(BLOCKERS.MANUAL_ACTION_REQUIRED).toMatchObject({
      blockerClass: "MANUAL",
      schedule: "NONE",
    });
    expect(BLOCKERS.MISSING_AUTHORIZED_DEPENDENCY.blockerClass).toBe("DETERMINISTIC_FAILURE");
  });

  it("maps non-dispatchable statuses to blockers; settled and runnable statuses have none", () => {
    expect(statusBlocker("AWAITING_APPROVAL")).toBe(BLOCKERS.AWAITING_APPROVAL);
    expect(statusBlocker("MANUAL_ACTION_REQUIRED")).toBe(BLOCKERS.MANUAL_ACTION_REQUIRED);
    expect(statusBlocker("PROVISIONING_FAILED")).toBe(BLOCKERS.PROVISIONING_FAILED);
    for (const s of [
      "READY_FOR_PROVISIONING",
      "PROVISIONING",
      "PROVISIONED",
      "DENIED",
      "REJECTED",
    ] as const) {
      expect(statusBlocker(s)).toBeNull();
    }
  });
});

describe("completion predicate", () => {
  it("is settled only for PROVISIONED, DENIED and REJECTED", () => {
    expect(["PROVISIONED", "DENIED", "REJECTED"].every((s) => isSettled(s as RequestStatus))).toBe(
      true,
    );
    for (const s of [
      "READY_FOR_PROVISIONING",
      "PROVISIONING",
      "AWAITING_APPROVAL",
      "PROVISIONING_FAILED",
      "MANUAL_ACTION_REQUIRED",
    ] as const) {
      expect(isSettled(s)).toBe(false);
      expect(completionState(["PROVISIONED", s]).complete).toBe(false);
    }
  });

  it("completes for all-settled, all-denied/rejected and zero resources; never with a plan issue", () => {
    expect(completionState(["PROVISIONED", "DENIED", "REJECTED"])).toEqual({
      complete: true,
      unresolved: 0,
    });
    expect(completionState(["DENIED", "REJECTED"]).complete).toBe(true);
    expect(completionState([]).complete).toBe(true);
    expect(completionState([], ["AMBIGUOUS_PROVISIONING_PLAN"]).complete).toBe(false);
    expect(completionState(["PROVISIONED", "READY_FOR_PROVISIONING"]).unresolved).toBe(1);
  });
});

describe("architecture: M7C consumes authorized state only", () => {
  it("provisioning modules never import the agents package or call a model", () => {
    const dir = fileURLToPath(new URL("../src/provisioning/", import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      expect(source, file).not.toMatch(/@aoo\/agents|openai|createRoleAccess|@aoo\/policy/i);
    }
    const events = readFileSync(
      fileURLToPath(new URL("../src/events/provisioning-workflow-wake.ts", import.meta.url)),
      "utf8",
    );
    expect(events).not.toMatch(/@aoo\/agents|openai/i);
  });
});
