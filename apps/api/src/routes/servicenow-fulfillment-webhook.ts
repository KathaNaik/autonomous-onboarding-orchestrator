import {
  FulfillmentCallbackError,
  type ServiceNowFulfillmentCallbackService,
} from "@aoo/orchestrator";
import {
  ServiceNowFulfillmentCallbackSchema,
  type FulfillmentCallbackErrorResponse,
} from "@aoo/shared";
import {
  SN_CALLBACK_SIGNATURE_HEADER,
  SN_CALLBACK_TIMESTAMP_HEADER,
  verifyServiceNowCallback,
} from "@aoo/webhooks";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

export interface ServiceNowFulfillmentWebhookOptions {
  secret: string;
  instance: string;
  table: string;
  maxSkewMs: number;
  bodyLimit: number;
  fulfillment: ServiceNowFulfillmentCallbackService;
}

function reject(
  reply: FastifyReply,
  statusCode: number,
  error: FulfillmentCallbackErrorResponse["error"],
  message: string,
) {
  const body: FulfillmentCallbackErrorResponse = { status: "rejected", error, message };
  return reply.code(statusCode).send(body);
}

const header = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * POST /webhooks/servicenow/fulfillment (M7D): a NOTIFICATION that a fulfillment record changed,
 * never a decision. Same authentication as the approval callback (HMAC over the raw bytes + a
 * timestamp window). It records the event and wakes provisioning; the worker then reads the
 * record back from ServiceNow and only its fulfillment_state decides. No ServiceNow credentials.
 */
export const serviceNowFulfillmentWebhookRoutes: FastifyPluginAsync<
  ServiceNowFulfillmentWebhookOptions
> = async (app, opts) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: opts.bodyLimit },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/servicenow/fulfillment", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const auth = verifyServiceNowCallback({
      rawBody,
      timestamp: header(request.headers[SN_CALLBACK_TIMESTAMP_HEADER]),
      signature: header(request.headers[SN_CALLBACK_SIGNATURE_HEADER]),
      secret: opts.secret,
      maxSkewMs: opts.maxSkewMs,
    });
    if (!auth.ok) {
      request.log.warn({ reason: auth.reason }, "fulfillment callback rejected: authentication");
      if (auth.reason === "MISSING")
        return reject(reply, 401, "AUTH_MISSING", "missing signature headers");
      if (auth.reason === "STALE")
        return reject(reply, 401, "AUTH_STALE", "timestamp outside the allowed window");
      return reject(reply, 401, "AUTH_INVALID", "signature does not match");
    }
    if (!/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
      return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reject(reply, 400, "MALFORMED_JSON", "request body is not valid JSON");
    }
    const parsed = ServiceNowFulfillmentCallbackSchema.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
      return reject(reply, 400, "INVALID_PAYLOAD", `invalid fields: ${fields.join(", ")}`);
    }
    const callback = parsed.data;
    if (callback.instance !== opts.instance || callback.table !== opts.table) {
      return reject(
        reply,
        422,
        "UNEXPECTED_SOURCE",
        "callback is not from the expected instance/table",
      );
    }
    try {
      const result = await opts.fulfillment.recordFulfillmentCallback(callback);
      request.log.info(
        { eventId: callback.eventId, number: callback.number, duplicate: result.duplicate },
        "servicenow fulfillment callback recorded",
      );
      return reply
        .code(202)
        .send({ status: "accepted", eventId: callback.eventId, duplicate: result.duplicate });
    } catch (err) {
      if (err instanceof FulfillmentCallbackError) {
        const status = err.code === "UNKNOWN_TICKET" ? 404 : 409;
        return reject(reply, status, err.code, err.message);
      }
      request.log.error(
        { eventId: callback.eventId, err: (err as Error).name },
        "fulfillment callback failed",
      );
      return reject(reply, 500, "INTERNAL_ERROR", "callback was not recorded; retry later");
    }
  });
};
