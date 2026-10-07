import { OPERATOR_ID_PATTERN, OfferLetterError, type OfferLetterService } from "@aoo/orchestrator";
import type { OfferLetterErrorResponse } from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  OPERATOR_ID_HEADER,
  operatorAuthorizer,
  type OperatorSessionCheck,
} from "./operator-auth.js";

export interface AdminOfferLetterRoutesOptions {
  adminToken: string;
  sessions?: OperatorSessionCheck;
  offerLetters: OfferLetterService;
}

/** Vercel Functions cap request bodies at 4.5 MB; the agent accepts up to 4 MB. */
export const OFFER_LETTER_MAX_BYTES = 4 * 1024 * 1024;

function reject(
  reply: FastifyReply,
  status: number,
  error: OfferLetterErrorResponse["error"],
  message: string,
) {
  return reply.code(status).send({ error, message } satisfies OfferLetterErrorResponse);
}

const STATUS_OF: Record<OfferLetterError["code"], number> = {
  EXTRACTION_UNAVAILABLE: 503,
  INVALID_DOCUMENT: 422,
  EXTRACTION_FAILED: 502,
  EXTRACTION_NOT_FOUND: 404,
  INVALID_PAYLOAD: 400,
  ALREADY_SUBMITTED: 409,
  EVENT_CONFLICT: 409,
  UPLOAD_LIMIT_REACHED: 429,
};

/**
 * (M11) Offer-letter intake for signed-in operators:
 *   POST /admin/offer-letters               body: the PDF bytes (Content-Type application/pdf)
 *   GET  /admin/offer-letters/:extractionId the proposal (never the file)
 *   POST /admin/offer-letters/:extractionId/start  the operator-confirmed fields (JSON)
 * Operator authorization (and session revocation) runs before any body parsing or database access.
 */
export const adminOfferLetterRoutes: FastifyPluginAsync<AdminOfferLetterRoutesOptions> = async (
  app,
  { adminToken, sessions, offerLetters },
) => {
  app.addContentTypeParser(
    "application/pdf",
    { parseAs: "buffer", bodyLimit: OFFER_LETTER_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler(
    (err: { code?: string; statusCode?: number; name?: string }, request, reply) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) {
        return reject(reply, 413, "PAYLOAD_TOO_LARGE", "the offer letter must be 4 MB or smaller");
      }
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.statusCode === 415) {
        return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "upload a PDF (application/pdf)");
      }
      if (err.statusCode === 400)
        return reject(reply, 400, "INVALID_PAYLOAD", "invalid request body");
      request.log.error(
        { errType: err.code ?? err.name ?? "Error" },
        "offer letter request failed",
      );
      return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
    },
  );
  app.addHook(
    "onRequest",
    operatorAuthorizer(
      adminToken,
      (reply) => reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
      sessions,
    ),
  );
  const operatorOf = (headers: Record<string, unknown>) => {
    const v = headers[OPERATOR_ID_HEADER];
    return typeof v === "string" && OPERATOR_ID_PATTERN.test(v) ? v : null;
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof OfferLetterError) {
      return reject(reply, STATUS_OF[err.code], err.code, err.message);
    }
    throw err;
  };

  app.post(
    "/admin/offer-letters",
    { bodyLimit: OFFER_LETTER_MAX_BYTES },
    async (request, reply) => {
      const operatorId = operatorOf(request.headers);
      if (!operatorId)
        return reject(reply, 400, "OPERATOR_ID_REQUIRED", "X-Operator-Id is required");
      if (!/^application\/pdf\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
        return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "upload a PDF (application/pdf)");
      }
      const pdf = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      try {
        const view = await offerLetters.extract({ pdf: new Uint8Array(pdf), operatorId });
        request.log.info({ operatorId, extractionId: view.extractionId }, "offer letter extracted");
        return reply.code(201).send(view);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { extractionId: string } }>(
    "/admin/offer-letters/:extractionId",
    async (request, reply) => {
      const view = await offerLetters.getExtraction(request.params.extractionId);
      if (!view) return reject(reply, 404, "EXTRACTION_NOT_FOUND", "offer letter not found");
      return reply.code(200).send(view);
    },
  );

  app.post<{ Params: { extractionId: string } }>(
    "/admin/offer-letters/:extractionId/start",
    { bodyLimit: 16_384 },
    async (request, reply) => {
      const operatorId = operatorOf(request.headers);
      if (!operatorId)
        return reject(reply, 400, "OPERATOR_ID_REQUIRED", "X-Operator-Id is required");
      try {
        const result = await offerLetters.submit({
          extractionId: request.params.extractionId,
          operatorId,
          confirmed: request.body,
        });
        request.log.info(
          { operatorId, extractionId: result.extractionId, workflowId: result.workflowId },
          "onboarding started from offer letter",
        );
        return reply.code(result.duplicate ? 200 : 201).send(result);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
};
