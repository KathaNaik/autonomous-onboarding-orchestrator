import { TERMINAL_WORKFLOW_STATES, type WorkflowState } from "@aoo/shared";
import { InvalidTransitionError } from "./errors.js";

/**
 * Allowed workflow-level transitions. The workflow state is an aggregate phase; per-resource
 * access requests (later milestones) move independently, which is why PROVISIONING and
 * AWAITING_APPROVAL may alternate: authorized resources provision while others still wait.
 */
export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  RECEIVED: ["ACCESS_PLANNING", "FAILED"],
  ACCESS_PLANNING: ["POLICY_REVIEW", "FAILED"],
  // PROVISIONING directly = approval not required.
  POLICY_REVIEW: ["AWAITING_APPROVAL", "PROVISIONING", "FAILED"],
  AWAITING_APPROVAL: ["PROVISIONING", "FAILED"],
  PROVISIONING: ["AWAITING_APPROVAL", "ONBOARDING_GENERATION", "FAILED"],
  ONBOARDING_GENERATION: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: WorkflowState): boolean {
  return (TERMINAL_WORKFLOW_STATES as readonly WorkflowState[]).includes(state);
}
