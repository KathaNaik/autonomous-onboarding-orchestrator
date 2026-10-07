import {
  OPERATOR_SESSION_HEADER,
  OfferLetterErrorResponseSchema,
  OfferLetterExtractionViewSchema,
  StartOnboardingFromOfferResponseSchema,
  type OfferLetterErrorResponse,
  type OfferLetterExtractionView,
  type StartOnboardingFromOfferResponse,
} from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";
import type { SessionCaller } from "./onboarding-read-api";

/** Vercel Functions cap request bodies at 4.5 MB; offer letters are limited to 4 MB. */
export const OFFER_LETTER_MAX_BYTES = 4 * 1024 * 1024;

/** Same structural check as the API: `%PDF-<n>.<n>` header and `%%EOF` in the last 1 KiB. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
  return (
    /^%PDF-\d\.\d/.test(latin1(bytes.subarray(0, 8))) &&
    latin1(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).includes("%%EOF")
  );
}

export type OfferResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: OfferLetterErrorResponse };

const UNAVAILABLE: OfferLetterErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};

/**
 * (M11) Server-side client for the API's offer-letter routes: the server-only token, the session's
 * operator id and nonce. The browser never talks to the API and never holds the token.
 */
async function call<T>(
  schema: z.ZodType<T>,
  path: string,
  caller: SessionCaller,
  init: { method: "GET" | "POST"; body?: BodyInit; contentType?: string },
  fetchImpl: typeof fetch,
): Promise<OfferResult<T>> {
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) return { ok: false, status: 503, body: UNAVAILABLE };
  let res: Response;
  try {
    res = await fetchImpl(new URL(path, config.API_BASE_URL), {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.ONBOARDING_ADMIN_TOKEN}`,
        "x-operator-id": caller.operatorId,
        [OPERATOR_SESSION_HEADER]: caller.nonce,
        ...(init.contentType && { "content-type": init.contentType }),
      },
      ...(init.body !== undefined && { body: init.body }),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 502, body: UNAVAILABLE };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const body = schema.safeParse(json);
    return body.success
      ? { ok: true, status: res.status, body: body.data }
      : { ok: false, status: 502, body: UNAVAILABLE };
  }
  const error = OfferLetterErrorResponseSchema.safeParse(json);
  if (error.success) return { ok: false, status: res.status, body: error.data };
  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      body: { error: "EXTRACTION_UNAVAILABLE", message: "Offer-letter intake is not enabled." },
    };
  }
  return { ok: false, status: res.status, body: UNAVAILABLE };
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;
const NOT_FOUND: OfferResult<never> = {
  ok: false,
  status: 404,
  body: { error: "EXTRACTION_NOT_FOUND", message: "Offer letter not found." },
};

export function uploadOfferLetter(pdf: Uint8Array, caller: SessionCaller, fetchImpl = fetch) {
  return call(
    OfferLetterExtractionViewSchema,
    "/admin/offer-letters",
    caller,
    { method: "POST", body: Buffer.from(pdf), contentType: "application/pdf" },
    fetchImpl,
  );
}

export function fetchOfferLetter(
  extractionId: string,
  caller: SessionCaller,
  fetchImpl = fetch,
): Promise<OfferResult<OfferLetterExtractionView>> {
  if (!isUuid(extractionId)) return Promise.resolve(NOT_FOUND);
  return call(
    OfferLetterExtractionViewSchema,
    `/admin/offer-letters/${extractionId}`,
    caller,
    { method: "GET" },
    fetchImpl,
  );
}

export function startOnboardingFromOffer(
  extractionId: string,
  confirmed: Record<string, unknown>,
  caller: SessionCaller,
  fetchImpl = fetch,
): Promise<OfferResult<StartOnboardingFromOfferResponse>> {
  if (!isUuid(extractionId)) return Promise.resolve(NOT_FOUND);
  return call(
    StartOnboardingFromOfferResponseSchema,
    `/admin/offer-letters/${extractionId}/start`,
    caller,
    { method: "POST", body: JSON.stringify(confirmed), contentType: "application/json" },
    fetchImpl,
  );
}

/** Fixed, operator-facing texts for error codes (no server text is echoed). */
export const OFFER_ERROR_MESSAGES: Record<string, string> = {
  INVALID_DOCUMENT: "That file isn't a readable PDF. Upload the offer letter as a PDF (4 MB max).",
  PAYLOAD_TOO_LARGE: "The file is larger than 4 MB.",
  UNSUPPORTED_MEDIA_TYPE: "Upload the offer letter as a PDF.",
  NO_FILE: "Choose a PDF to upload.",
  EXTRACTION_FAILED: "The letter couldn't be read right now. Nothing was started; try again.",
  ATTESTATION_REQUIRED:
    "Confirm that the offer is signed and the candidate is cleared. Nothing was started.",
  EXTRACTION_UNAVAILABLE: "Offer-letter intake is not enabled on this server.",
  EXTRACTION_NOT_FOUND: "Offer letter not found.",
  INVALID_PAYLOAD:
    "Some details are missing or invalid. Check every field, the department/role combination and the confirmation box.",
  ALREADY_SUBMITTED: "This offer letter already started an onboarding with different details.",
  EVENT_CONFLICT: "This offer letter already started an onboarding with different details.",
  UPLOAD_LIMIT_REACHED:
    "The daily offer-letter limit is reached (per account or overall). Nothing was read; try again tomorrow.",
  INTERNAL_ERROR: "Something went wrong. Try again.",
};
