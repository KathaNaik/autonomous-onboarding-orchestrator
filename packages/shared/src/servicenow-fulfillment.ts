import { z } from "zod";
import { ServiceNowApprovalCallbackSchema } from "./approvals.js";

/**
 * Body of POST /webhooks/servicenow/fulfillment (M7D). Same identifiers and security model as the
 * approval callback. A NOTIFICATION only: it makes the backend read the fulfillment record back
 * from ServiceNow; `claimedFulfillmentState` is a diagnostic hint and never decides anything.
 */
export const ServiceNowFulfillmentCallbackSchema = ServiceNowApprovalCallbackSchema.omit({
  claimedApprovalState: true,
}).extend({
  claimedFulfillmentState: z.string().trim().max(40).optional(),
});
export type ServiceNowFulfillmentCallback = z.infer<typeof ServiceNowFulfillmentCallbackSchema>;

export const FulfillmentCallbackAcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  eventId: z.string(),
  duplicate: z.boolean(),
});

export const FULFILLMENT_CALLBACK_ERROR_CODES = [
  "AUTH_MISSING",
  "AUTH_INVALID",
  "AUTH_STALE",
  "UNSUPPORTED_MEDIA_TYPE",
  "MALFORMED_JSON",
  "INVALID_PAYLOAD",
  "UNEXPECTED_SOURCE",
  "EVENT_ID_CONFLICT",
  /** No fulfillment operation of ours has this correlation key. */
  "UNKNOWN_TICKET",
  /** The sys_id/number don't match the fulfillment record we created for that key. */
  "IDENTITY_MISMATCH",
  "INTERNAL_ERROR",
] as const;
export const FulfillmentCallbackErrorResponseSchema = z.object({
  status: z.literal("rejected"),
  error: z.enum(FULFILLMENT_CALLBACK_ERROR_CODES),
  message: z.string(),
});
export type FulfillmentCallbackErrorResponse = z.infer<
  typeof FulfillmentCallbackErrorResponseSchema
>;
