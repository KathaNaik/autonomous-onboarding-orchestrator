import { z } from "zod";
import { checkFactCombination, employeeFactsShape } from "./employee-facts.js";

export const HRIS_OFFER_STATUSES = ["SIGNED", "PENDING", "DECLINED", "RESCINDED"] as const;
export const HRIS_CANDIDATE_STATUSES = ["CLEARED", "PENDING", "NOT_CLEARED"] as const;

const Text = z.string().trim().min(1).max(200);

/**
 * Body of POST /webhooks/hris. Unknown fields are stripped.
 *
 * `role` and `department` are display text only. The canonical codes (M5C) are the authoritative
 * facts for authorization; they are validated exactly and never derived from the display text.
 */
export const HrisOfferSignedEventSchema = z
  .object({
    eventId: Text,
    eventType: z.literal("offer.signed"),
    occurredAt: z.iso.datetime({ offset: true }),
    employeeId: Text,
    employee: z.object({
      firstName: Text,
      lastName: Text,
      email: z.email(),
    }),
    role: Text,
    department: Text,
    /**
     * Optional job responsibilities (M6A): free text for the Role Access Agent's recommendations
     * only. Untrusted content; never an authorization fact, never parsed into codes.
     */
    jobDescription: z.string().trim().min(1).max(4000).optional(),
    managerId: Text,
    offerStatus: z.enum(HRIS_OFFER_STATUSES),
    candidateStatus: z.enum(HRIS_CANDIDATE_STATUSES),
    ...employeeFactsShape,
  })
  .superRefine(checkFactCombination);
export type HrisOfferSignedEvent = z.infer<typeof HrisOfferSignedEventSchema>;

/** Only signed offers for cleared candidates may start onboarding. */
export function isOnboardingEligible(
  event: Pick<HrisOfferSignedEvent, "offerStatus" | "candidateStatus">,
): boolean {
  return event.offerStatus === "SIGNED" && event.candidateStatus === "CLEARED";
}

/** 202 body for an accepted (or already-accepted) event. */
export const HrisWebhookAcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  eventId: z.string(),
  workflowId: z.uuid(),
  workflowCreated: z.boolean(),
  duplicate: z.boolean(),
});
export type HrisWebhookAcceptedResponse = z.infer<typeof HrisWebhookAcceptedResponseSchema>;

export const HRIS_WEBHOOK_ERROR_CODES = [
  "SIGNATURE_MISSING",
  "SIGNATURE_INVALID",
  "SIGNATURE_STALE",
  "UNSUPPORTED_MEDIA_TYPE",
  "MALFORMED_JSON",
  "INVALID_PAYLOAD",
  "NOT_ELIGIBLE",
  "EVENT_ID_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export const HrisWebhookErrorResponseSchema = z.object({
  status: z.literal("rejected"),
  error: z.enum(HRIS_WEBHOOK_ERROR_CODES),
  message: z.string(),
});
export type HrisWebhookErrorResponse = z.infer<typeof HrisWebhookErrorResponseSchema>;
