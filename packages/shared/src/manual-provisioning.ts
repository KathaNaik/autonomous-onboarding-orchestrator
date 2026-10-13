import { z } from "zod";

/**
 * M7C operator completion of a provider=MANUAL resource
 * (`POST /admin/access-requests/:accessRequestId/manual-complete`). The evidence rules
 * (8–500 characters, no credentials) are enforced by the orchestrator; this is the wire shape.
 */
export const ManualCompletionRequestSchema = z.strictObject({ evidence: z.string().max(2000) });
export type ManualCompletionRequest = z.infer<typeof ManualCompletionRequestSchema>;

export const ManualCompletionResponseSchema = z.object({
  accessRequestId: z.uuid(),
  workflowId: z.uuid(),
  resourceId: z.string(),
  status: z.literal("PROVISIONED"),
  /** False for an identical repeat (same operator and evidence). */
  changed: z.boolean(),
  completedBy: z.string(),
  provisionedAt: z.string(),
});
export type ManualCompletionResponse = z.infer<typeof ManualCompletionResponseSchema>;

export const ManualCompletionErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ManualCompletionErrorResponse = z.infer<typeof ManualCompletionErrorResponseSchema>;
