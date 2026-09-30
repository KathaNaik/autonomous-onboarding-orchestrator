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
