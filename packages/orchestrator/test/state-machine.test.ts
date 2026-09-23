import { WORKFLOW_STATES, type WorkflowState } from "@aoo/shared";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../src/errors.js";
import {
  WORKFLOW_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
} from "../src/state-machine.js";

const VALID: Array<[WorkflowState, WorkflowState]> = [
  ["RECEIVED", "ACCESS_PLANNING"],
  ["ACCESS_PLANNING", "POLICY_REVIEW"],
  ["POLICY_REVIEW", "AWAITING_APPROVAL"],
  ["POLICY_REVIEW", "PROVISIONING"],
  ["AWAITING_APPROVAL", "PROVISIONING"],
  ["PROVISIONING", "AWAITING_APPROVAL"],
  ["PROVISIONING", "ONBOARDING_GENERATION"],
  ["ONBOARDING_GENERATION", "COMPLETED"],
  ...WORKFLOW_STATES.filter((s) => !isTerminal(s)).map(
    (s) => [s, "FAILED"] as [WorkflowState, WorkflowState],
  ),
];

const isValid = (from: WorkflowState, to: WorkflowState) =>
  VALID.some(([f, t]) => f === from && t === to);

const ALL_PAIRS = WORKFLOW_STATES.flatMap((from) =>
  WORKFLOW_STATES.map((to) => [from, to] as [WorkflowState, WorkflowState]),
);

describe("workflow state machine", () => {
  it("defines transitions for every state", () => {
    expect(Object.keys(WORKFLOW_TRANSITIONS).sort()).toEqual([...WORKFLOW_STATES].sort());
  });

  it.each(ALL_PAIRS)("%s -> %s matches the allowed transition table", (from, to) => {
    expect(canTransition(from, to)).toBe(isValid(from, to));
  });

  it("allows skipping approval when policy review finds none is needed", () => {
    expect(canTransition("POLICY_REVIEW", "PROVISIONING")).toBe(true);
  });

  it("allows provisioning and approval to alternate for per-resource progress", () => {
    expect(canTransition("PROVISIONING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "PROVISIONING")).toBe(true);
  });

  it("rejects self-transitions and skipping phases", () => {
    expect(canTransition("RECEIVED", "RECEIVED")).toBe(false);
    expect(canTransition("RECEIVED", "COMPLETED")).toBe(false);
    expect(canTransition("ACCESS_PLANNING", "PROVISIONING")).toBe(false);
  });

  it("treats COMPLETED and FAILED as terminal with no outgoing transitions", () => {
    for (const s of ["COMPLETED", "FAILED"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(WORKFLOW_TRANSITIONS[s]).toEqual([]);
    }
    expect(isTerminal("PROVISIONING")).toBe(false);
  });

  it("assertTransition throws a typed error for invalid transitions", () => {
    expect(() => assertTransition("RECEIVED", "ACCESS_PLANNING")).not.toThrow();
    const err = (() => {
      try {
        assertTransition("COMPLETED", "PROVISIONING");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err).toMatchObject({
      code: "INVALID_TRANSITION",
      from: "COMPLETED",
      to: "PROVISIONING",
    });
  });
});
