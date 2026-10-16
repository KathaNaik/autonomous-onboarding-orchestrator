import { z } from "zod";

/** Emitted once per accepted HRIS offer.signed event. Consumed by the outbox worker (M3B). */
export const HrisOfferSignedAcceptedPayloadSchema = z.object({
  workflowId: z.uuid(),
  workflowCreated: z.boolean(),
  receiptId: z.uuid(),
  hrisEventId: z.string(),
  hrisEventType: z.literal("offer.signed"),
  hrisEmployeeId: z.string(),
});
export type HrisOfferSignedAcceptedPayload = z.infer<typeof HrisOfferSignedAcceptedPayloadSchema>;

export const OUTBOX_EVENT_TYPES = {
  hrisOfferSignedAccepted: "hris.offer_signed.accepted",
  externalOperationExecute: "external_operation.execute",
  approvalCallbackReceived: "servicenow.approval_callback.received",
  provisioningWorkflowWake: "provisioning.workflow.wake",
  onboardingPlanGenerate: "onboarding.plan.generate",
  accessPlanningRequested: "access.planning.requested",
  approvalRerequestRequested: "approval.rerequest.requested",
} as const;

/** Asks a worker to execute (or resume/reconcile) one durable external operation. */
export const ExternalOperationExecutePayloadSchema = z.object({
  operationId: z.uuid(),
  provider: z.string(),
  operationType: z.string(),
});
export type ExternalOperationExecutePayload = z.infer<typeof ExternalOperationExecutePayloadSchema>;

/** M7C: why provisioning was woken (diagnostics only; every wake runs the same coordinator). */
export const PROVISIONING_WAKE_REASONS = [
  "PLAN_CREATED",
  "APPROVAL_DECIDED",
  "WORKFLOW_RESUMED",
  "GITHUB_IDENTITY_RECORDED",
  "MANUAL_RESOURCE_COMPLETED",
  "SERVICENOW_FULFILLMENT_CHANGED",
  "SCHEDULED_RECONCILIATION",
  "CONTINUATION",
  "LEGACY_ADOPTION",
  /** M13: an operator asked to retry a failed resource. */
  "RESOURCE_RETRY_REQUESTED",
] as const;

/**
 * M7C: asks a worker to (re)coordinate provisioning for one workflow. Written in the same
 * transaction as the state change that makes progress possible. Duplicates are harmless: the
 * coordinator is idempotent under at-least-once delivery.
 */
export const ProvisioningWorkflowWakePayloadSchema = z.object({
  workflowId: z.uuid(),
  reason: z.enum(PROVISIONING_WAKE_REASONS),
});
export type ProvisioningWorkflowWakePayload = z.infer<typeof ProvisioningWorkflowWakePayloadSchema>;

/** M8: why onboarding-plan generation was requested (diagnostics only). */
export const ONBOARDING_PLAN_GENERATE_REASONS = [
  /** Written in the same transaction as PROVISIONING → ONBOARDING_GENERATION. */
  "PROVISIONING_SETTLED",
  /** The periodic sweeper found a workflow in ONBOARDING_GENERATION without an accepted plan. */
  "SCHEDULED_RECOVERY",
] as const;

/**
 * M8: asks a worker to generate (or finish) the onboarding plan of one workflow in
 * ONBOARDING_GENERATION. Duplicates are harmless: one logical run, at most one accepted plan.
 */
export const OnboardingPlanGeneratePayloadSchema = z.object({
  workflowId: z.uuid(),
  reason: z.enum(ONBOARDING_PLAN_GENERATE_REASONS),
});
export type OnboardingPlanGeneratePayload = z.infer<typeof OnboardingPlanGeneratePayloadSchema>;

/** M10: why access planning was requested (diagnostics only). */
export const ACCESS_PLANNING_REASONS = [
  /** Written in the same transaction as RECEIVED → ACCESS_PLANNING. */
  "WORKFLOW_STARTED",
  /** The periodic sweeper found a workflow in ACCESS_PLANNING/POLICY_REVIEW still to plan. */
  "SCHEDULED_RECOVERY",
] as const;

/**
 * M10: asks a worker to run the Role Access Agent for a started workflow and authorize its
 * recommendations with the policy engine. Duplicates are harmless: one logical agent run, one
 * decision per resource.
 */
export const AccessPlanningRequestedPayloadSchema = z.object({
  workflowId: z.uuid(),
  reason: z.enum(ACCESS_PLANNING_REASONS),
});
export type AccessPlanningRequestedPayload = z.infer<typeof AccessPlanningRequestedPayloadSchema>;

/**
 * M13: an operator asked for a new approval ticket for one resource. A worker reads the current
 * ticket back from ServiceNow and only replaces it when ServiceNow confirms it no longer exists.
 * Duplicates are harmless: the replacement is keyed by the resource's next retry generation.
 */
export const ApprovalRerequestRequestedPayloadSchema = z.object({
  accessRequestId: z.uuid(),
  approvalId: z.uuid(),
  operatorId: z.string().min(1).max(64),
});
export type ApprovalRerequestRequestedPayload = z.infer<
  typeof ApprovalRerequestRequestedPayloadSchema
>;
