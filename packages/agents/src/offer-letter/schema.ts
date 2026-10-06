import { z } from "zod";

/**
 * (M11) Offer Letter Extractor output contract. Display fields only: never authorization facts
 * (department/role-family/employment-type codes), never compensation or personal identifiers.
 * Warnings are a closed code list so untrusted document text can't flow through them.
 */
export const OFFER_LETTER_WARNINGS = [
  "NOT_AN_OFFER_LETTER",
  "FIELD_NOT_FOUND",
  "MULTIPLE_CANDIDATES",
  "UNREADABLE_DOCUMENT",
  "AMBIGUOUS_START_DATE",
] as const;
export type OfferLetterWarning = (typeof OFFER_LETTER_WARNINGS)[number];

const field = (max: number) => z.string().trim().max(max).nullable();

export const OfferLetterModelOutputSchema = z.strictObject({
  isOfferLetter: z.boolean(),
  firstName: field(100),
  lastName: field(100),
  workEmail: field(254),
  jobTitle: field(200),
  department: field(200),
  managerName: field(200),
  startDate: field(10),
  jobSummary: field(1500),
  warnings: z.array(z.enum(OFFER_LETTER_WARNINGS)).max(5),
});
export type OfferLetterModelOutput = z.infer<typeof OfferLetterModelOutputSchema>;

export const OFFER_LETTER_OUTPUT_SCHEMA_NAME = "offer_letter_fields";

const nullableString = { type: ["string", "null"] } as const;
/** Strict JSON schema for Structured Outputs; kept in step with the Zod contract by a test. */
export const OFFER_LETTER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "isOfferLetter",
    "firstName",
    "lastName",
    "workEmail",
    "jobTitle",
    "department",
    "managerName",
    "startDate",
    "jobSummary",
    "warnings",
  ],
  properties: {
    isOfferLetter: { type: "boolean" },
    firstName: nullableString,
    lastName: nullableString,
    workEmail: nullableString,
    jobTitle: nullableString,
    department: nullableString,
    managerName: nullableString,
    startDate: nullableString,
    jobSummary: nullableString,
    warnings: { type: "array", items: { type: "string", enum: [...OFFER_LETTER_WARNINGS] } },
  },
} as const;

/** What the rest of the system receives: validated, cleaned, compensation-free proposals. */
export const OfferLetterProposalSchema = z.strictObject({
  isOfferLetter: z.boolean(),
  firstName: z.string().max(100).nullable(),
  lastName: z.string().max(100).nullable(),
  workEmail: z.string().max(254).nullable(),
  jobTitle: z.string().max(200).nullable(),
  department: z.string().max(200).nullable(),
  managerName: z.string().max(200).nullable(),
  startDate: z.string().max(10).nullable(),
  jobSummary: z.string().max(1500).nullable(),
  warnings: z.array(z.string()).max(12),
});
export type OfferLetterProposal = z.infer<typeof OfferLetterProposalSchema>;
