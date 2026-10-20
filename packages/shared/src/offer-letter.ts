import { z } from "zod";
import { checkFactCombination, employeeFactsShape } from "./employee-facts.js";
import { StartDateSchema } from "./hris.js";

/**
 * (M11) Offer-letter intake contracts, shared by the API and the web app.
 *
 * Flow: operator uploads a PDF → the Offer Letter Extractor proposes display fields → the operator
 * corrects them, chooses the canonical facts and attests the offer is signed and the candidate
 * cleared → the API runs the same intake as the HRIS webhook. The AI never sets canonical facts.
 */
export const OFFER_LETTER_EXTRACTION_STATUSES = ["EXTRACTED", "SUBMITTED"] as const;

const nullable = (max: number) => z.string().max(max).nullable();

/** Display fields proposed from the letter (compensation and personal identifiers removed). */
export const OfferLetterProposalViewSchema = z.strictObject({
  isOfferLetter: z.boolean(),
  firstName: nullable(100),
  lastName: nullable(100),
  workEmail: nullable(254),
  jobTitle: nullable(200),
  department: nullable(200),
  managerName: nullable(200),
  startDate: nullable(10),
  jobSummary: nullable(1500),
  warnings: z.array(z.string().max(80)).max(12),
});
export type OfferLetterProposalView = z.infer<typeof OfferLetterProposalViewSchema>;

export const OfferLetterExtractionViewSchema = z.strictObject({
  extractionId: z.uuid(),
  status: z.enum(OFFER_LETTER_EXTRACTION_STATUSES),
  proposal: OfferLetterProposalViewSchema,
  uploadedBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  workflowId: z.uuid().nullable(),
});
export type OfferLetterExtractionView = z.infer<typeof OfferLetterExtractionViewSchema>;

const Text = z.string().trim().min(1).max(200);

/** What the operator confirms and submits (strict: nothing else is accepted). */
export const StartOnboardingFromOfferRequestSchema = z
  .strictObject({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    role: Text,
    department: Text,
    managerId: Text,
    /** Employment start date the operator confirmed (display and timing only). */
    startDate: StartDateSchema.optional(),
    jobDescription: z.string().trim().min(1).max(4000).optional(),
    /** The operator attests the offer is signed and the candidate cleared (HRIS eligibility). */
    offerSignedAndCleared: z.literal(true),
    ...employeeFactsShape,
  })
  .superRefine(checkFactCombination);
export type StartOnboardingFromOfferRequest = z.infer<typeof StartOnboardingFromOfferRequestSchema>;

export const StartOnboardingFromOfferResponseSchema = z.strictObject({
  extractionId: z.uuid(),
  eventId: z.string(),
  workflowId: z.uuid(),
  workflowCreated: z.boolean(),
  duplicate: z.boolean(),
});
export type StartOnboardingFromOfferResponse = z.infer<
  typeof StartOnboardingFromOfferResponseSchema
>;

export const OFFER_LETTER_ERROR_CODES = [
  "OPERATOR_UNAUTHORIZED",
  "OPERATOR_ID_REQUIRED",
  "UNSUPPORTED_MEDIA_TYPE",
  "INVALID_DOCUMENT",
  "PAYLOAD_TOO_LARGE",
  "INVALID_PAYLOAD",
  "EXTRACTION_FAILED",
  "EXTRACTION_UNAVAILABLE",
  "EXTRACTION_NOT_FOUND",
  "ALREADY_SUBMITTED",
  "EVENT_CONFLICT",
  /** (M12) The daily upload cap (per operator or overall) is reached; nothing reached the model. */
  "UPLOAD_LIMIT_REACHED",
  /** This account already started its allowed onboardings in the last 24 hours; nothing was started. */
  "ONBOARDING_LIMIT_REACHED",
  "INTERNAL_ERROR",
] as const;
export const OfferLetterErrorResponseSchema = z.object({
  error: z.enum(OFFER_LETTER_ERROR_CODES),
  message: z.string(),
});
export type OfferLetterErrorResponse = z.infer<typeof OfferLetterErrorResponseSchema>;
