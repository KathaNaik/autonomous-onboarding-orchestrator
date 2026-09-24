import { ApprovalProcessingError, type ApprovalService } from "@aoo/orchestrator";
import { ServiceNowApprovalCallbackSchema, type ApprovalCallbackErrorResponse } from "@aoo/shared";
import {
  SN_CALLBACK_SIGNATURE_HEADER,
  SN_CALLBACK_TIMESTAMP_HEADER,
  verifyServiceNowCallback,
} from "@aoo/webhooks";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

export interface ServiceNowApprovalWebhookOptions {
  secret: string;
  /** Expected sender identity: the PDI instance name and the scoped table. */
  instance: string;
  table: string;
  maxSkewMs: number;
  bodyLimit: number;
  approvals: ApprovalService;
}

function reject(
  reply: FastifyReply,
  statusCode: number,
  error: ApprovalCallbackErrorResponse["error"],
  message: string,
) {
  const body: ApprovalCallbackErrorResponse = { status: "rejected", error, message };
  return reply.code(statusCode).send(body);
}

const header = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * POST /webhooks/servicenow/approvals: a NOTIFICATION, never a decision. Authenticates the raw
 * bytes (HMAC + timestamp), validates the minimal identifiers, checks the sender identity, and
 * durably records the event (deduplicated by event id) before answering 202. The worker later
 * reads the ticket back from ServiceNow and decides. Headers and bodies are never logged.
 */
export const serviceNowApprovalWebhookRoutes: FastifyPluginAsync<
  ServiceNowApprovalWebhookOptions
> = async (app, opts) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: opts.bodyLimit },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/servicenow/approvals", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const auth = verifyServiceNowCallback({
      rawBody,
      timestamp: header(request.headers[SN_CALLBACK_TIMESTAMP_HEADER]),
      signature: header(request.headers[SN_CALLBACK_SIGNATURE_HEADER]),
      secret: opts.secret,
      maxSkewMs: opts.maxSkewMs,
    });
    if (!auth.ok) {
      request.log.warn({ reason: auth.reason }, "servicenow callback rejected: authentication");
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
    const parsed = ServiceNowApprovalCallbackSchema.safeParse(json);
    if (!parsed.success) {
      // Field paths only: never echo submitted values.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
      return reject(reply, 400, "INVALID_PAYLOAD", `invalid fields: ${fields.join(", ")}`);
    }
    const callback = parsed.data;
    if (callback.instance !== opts.instance || callback.table !== opts.table) {
      request.log.warn(
        { eventId: callback.eventId },
        "servicenow callback rejected: unexpected source",
      );
      return reject(
        reply,
        422,
        "UNEXPECTED_SOURCE",
        "callback is not from the expected instance/table",
      );
    }

    try {
      const result = await opts.approvals.recordServiceNowCallback(callback);
      request.log.info(
        { eventId: callback.eventId, number: callback.number, duplicate: result.duplicate },
        "servicenow approval callback recorded",
      );
      return reply
        .code(202)
        .send({ status: "accepted", eventId: callback.eventId, duplicate: result.duplicate });
    } catch (err) {
      if (err instanceof ApprovalProcessingError && err.code === "EVENT_ID_CONFLICT") {
        return reject(reply, 409, "EVENT_ID_CONFLICT", err.message);
      }
      request.log.error(
        { eventId: callback.eventId, err: (err as Error).name },
        "servicenow callback persistence failed",
      );
      return reject(reply, 500, "INTERNAL_ERROR", "callback was not recorded; retry later");
    }
  });
};
