import { z } from "zod";

/** Our approval lifecycle (per resource / external operation). */
export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const SysId = z.string().regex(/^[0-9a-f]{32}$/);
const Identifier = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9:._-]+$/);

/**
 * Body of POST /webhooks/servicenow/approvals. Identifiers only: it is a NOTIFICATION that
 * causes an authoritative read-back, never a decision. Unknown fields (e.g. employee data) are
 * stripped. `claimedApprovalState` is a diagnostic hint and is never used to decide anything.
 */
export const ServiceNowApprovalCallbackSchema = z.object({
  /** Durable change identifier: "<sys_id>:<sys_mod_count>" from the business rule. */
  eventId: z
    .string()
    .trim()
    .min(3)
    .max(100)
    .regex(/^[A-Za-z0-9:._-]+$/),
  instance: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  table: z
    .string()
    .trim()
    .regex(/^x_[a-z0-9_]+$/),
  sysId: SysId,
  number: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z]+\d+$/),
  correlationKey: Identifier,
  claimedApprovalState: z.string().trim().max(40).optional(),
});
export type ServiceNowApprovalCallback = z.infer<typeof ServiceNowApprovalCallbackSchema>;

export const ApprovalCallbackAcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  eventId: z.string(),
  duplicate: z.boolean(),
});

export const APPROVAL_CALLBACK_ERROR_CODES = [
  "AUTH_MISSING",
  "AUTH_INVALID",
  "AUTH_STALE",
  "UNSUPPORTED_MEDIA_TYPE",
  "MALFORMED_JSON",
  "INVALID_PAYLOAD",
  "UNEXPECTED_SOURCE",
  "EVENT_ID_CONFLICT",
  "INTERNAL_ERROR",
] as const;
export const ApprovalCallbackErrorResponseSchema = z.object({
  status: z.literal("rejected"),
  error: z.enum(APPROVAL_CALLBACK_ERROR_CODES),
  message: z.string(),
});
export type ApprovalCallbackErrorResponse = z.infer<typeof ApprovalCallbackErrorResponseSchema>;

/** Outbox payload asking a worker to verify one recorded callback against ServiceNow. */
export const ApprovalCallbackReceivedPayloadSchema = z.object({ callbackEventId: z.uuid() });
