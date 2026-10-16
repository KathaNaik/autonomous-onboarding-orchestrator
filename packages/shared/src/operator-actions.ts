import { z } from "zod";

/**
 * M13 operator actions on one resource of a workflow:
 *   POST /admin/access-requests/:accessRequestId/retry             retry a failed resource
 *   POST /admin/access-requests/:accessRequestId/request-approval  ask for a new approval ticket
 * Both need operator authorization and change only orchestration state; neither changes or
 * bypasses the recorded authorization.
 */

export const RetryResourceResponseSchema = z.object({
  accessRequestId: z.uuid(),
  workflowId: z.uuid(),
  resourceId: z.string(),
  status: z.literal("READY_FOR_PROVISIONING"),
  /** How many times this resource has been retried or re-requested (1 = the first retry). */
  retryGeneration: z.number().int().positive(),
});
export type RetryResourceResponse = z.infer<typeof RetryResourceResponseSchema>;

export const RequestApprovalAgainResponseSchema = z.object({
  accessRequestId: z.uuid(),
  approvalId: z.uuid(),
  /** Accepted: a worker checks the current ticket and replaces it only if it no longer exists. */
  status: z.literal("REQUESTED"),
  /** False when the same request was already accepted (idempotent repeat). */
  changed: z.boolean(),
});
export type RequestApprovalAgainResponse = z.infer<typeof RequestApprovalAgainResponseSchema>;

export const OPERATOR_ACTION_ERROR_CODES = [
  "OPERATOR_UNAUTHORIZED",
  "OPERATOR_ID_REQUIRED",
  "ACCESS_REQUEST_NOT_FOUND",
  /** Retry: the resource isn't in PROVISIONING_FAILED. */
  "NOT_FAILED",
  /** Request approval: the resource isn't waiting on an approval ticket. */
  "NOT_AWAITING_APPROVAL",
  /** The resource isn't part of the workflow's active provisioning plan (e.g. an old agent run). */
  "NOT_IN_ACTIVE_PLAN",
  /** The workflow is completed or failed. */
  "WORKFLOW_NOT_ACTIVE",
  "INTERNAL_ERROR",
] as const;
export type OperatorActionErrorCode = (typeof OPERATOR_ACTION_ERROR_CODES)[number];

export const OperatorActionErrorResponseSchema = z.object({
  error: z.enum(OPERATOR_ACTION_ERROR_CODES),
  message: z.string(),
});
export type OperatorActionErrorResponse = z.infer<typeof OperatorActionErrorResponseSchema>;
