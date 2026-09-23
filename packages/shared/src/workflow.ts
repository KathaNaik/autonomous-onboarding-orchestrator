import { z } from "zod";

/**
 * Coarse, workflow-level phases. Per-resource access requests (later milestones) carry their
 * own states, so this is an aggregate view, not a single global gate for all access.
 */
export const WORKFLOW_STATES = [
  "RECEIVED",
  "ACCESS_PLANNING",
  "POLICY_REVIEW",
  "AWAITING_APPROVAL",
  "PROVISIONING",
  "ONBOARDING_GENERATION",
  "COMPLETED",
  "FAILED",
] as const;

export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const TERMINAL_WORKFLOW_STATES = [
  "COMPLETED",
  "FAILED",
] as const satisfies readonly WorkflowState[];
