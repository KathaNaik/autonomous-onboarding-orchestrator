import {
  HrisEventConflictError,
  HrisEventNotEligibleError,
  type HrisIntakeService,
} from "@aoo/orchestrator";
import {
  HrisOfferSignedEventSchema,
  type HrisWebhookAcceptedResponse,
  type HrisWebhookErrorResponse,
} from "@aoo/shared";
import { HRIS_SIGNATURE_HEADER, verifyHrisSignature } from "@aoo/webhooks";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

export interface HrisWebhookOptions {
  secret: string;
  bodyLimit: number;
  intake: HrisIntakeService;
}

function reject(
  reply: FastifyReply,
  statusCode: number,
  error: HrisWebhookErrorResponse["error"],
  message: string,
) {
  const body: HrisWebhookErrorResponse = { status: "rejected", error, message };
  return reply.code(statusCode).send(body);
}

/**
 * POST /webhooks/hris. Order matters: authenticate the raw bytes, then parse, then validate,
 * then persist. 202 is sent only after the intake transaction has committed.
 */
export const hrisWebhookRoutes: FastifyPluginAsync<HrisWebhookOptions> = async (app, opts) => {
  // Keep the exact request bytes for HMAC verification (scoped to this plugin only).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: opts.bodyLimit },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/hris", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

    const signature = request.headers[HRIS_SIGNATURE_HEADER];
    if (typeof signature !== "string" || signature.length === 0) {
      return reject(reply, 401, "SIGNATURE_MISSING", `missing ${HRIS_SIGNATURE_HEADER} header`);
    }
    if (!verifyHrisSignature(rawBody, signature, opts.secret)) {
      request.log.warn("hris webhook rejected: invalid signature");
      return reject(reply, 401, "SIGNATURE_INVALID", "signature does not match request body");
    }

    const contentType = request.headers["content-type"] ?? "";
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reject(reply, 400, "MALFORMED_JSON", "request body is not valid JSON");
    }

    const parsed = HrisOfferSignedEventSchema.safeParse(json);
    if (!parsed.success) {
      return reject(reply, 400, "INVALID_PAYLOAD", z.prettifyError(parsed.error));
    }
    const event = parsed.data;

    try {
      const result = await opts.intake.acceptOfferSigned(event);
      request.log.info(
        { eventId: event.eventId, workflowId: result.workflowId, duplicate: result.duplicate },
        "hris event accepted",
      );
      const body: HrisWebhookAcceptedResponse = {
        status: "accepted",
        eventId: event.eventId,
        workflowId: result.workflowId,
        workflowCreated: result.workflowCreated,
        duplicate: result.duplicate,
      };
      return reply.code(202).send(body);
    } catch (err) {
      if (err instanceof HrisEventNotEligibleError) {
        return reject(reply, 422, "NOT_ELIGIBLE", err.message);
      }
      if (err instanceof HrisEventConflictError) {
        return reject(reply, 409, "EVENT_ID_CONFLICT", err.message);
      }
      request.log.error({ err, eventId: event.eventId }, "hris event persistence failed");
      return reject(reply, 500, "INTERNAL_ERROR", "event was not accepted; retry later");
    }
  });
};
