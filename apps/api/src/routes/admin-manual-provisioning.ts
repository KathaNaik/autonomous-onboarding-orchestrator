import {
  ManualCompletionError,
  OPERATOR_ID_PATTERN,
  type ManualProvisioningService,
} from "@aoo/orchestrator";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { OPERATOR_ID_HEADER, operatorAuthorizer } from "./operator-auth.js";

export interface AdminManualProvisioningRoutesOptions {
  /** ONBOARDING_ADMIN_TOKEN (the M7B operator trust boundary). */
  adminToken: string;
  manual: ManualProvisioningService;
}

type ErrorCode =
  | "OPERATOR_UNAUTHORIZED"
  | "OPERATOR_ID_REQUIRED"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL_ERROR"
  | Exclude<ManualCompletionError["code"], "INVALID_OPERATOR_ID">;

export interface ManualCompletionErrorResponse {
  error: ErrorCode;
  message: string;
}

const BodySchema = z.strictObject({ evidence: z.string().max(2000) });
const ParamsSchema = z.object({ accessRequestId: z.uuid() });

const STATUS_OF: Record<ManualCompletionError["code"], number> = {
  INVALID_OPERATOR_ID: 400,
  INVALID_EVIDENCE: 400,
  ACCESS_REQUEST_NOT_FOUND: 404,
  NOT_ELIGIBLE: 409,
  AUTHORIZATION_CHAIN_INVALID: 409,
  CATALOG_UNAVAILABLE: 409,
  RESOURCE_NOT_IN_CATALOG: 409,
  PROVIDER_NOT_MANUAL: 409,
  NOT_IN_ACTIVE_PLAN: 409,
  NOT_AWAITING_MANUAL_ACTION: 409,
  MANUAL_ALREADY_COMPLETED: 409,
};

function reject(reply: FastifyReply, status: number, error: ErrorCode, message: string) {
  const body: ManualCompletionErrorResponse = { error, message };
  return reply.code(status).send(body);
}

/**
 * M7C: an HR/onboarding operator confirms an authorized provider=MANUAL resource was provisioned
 * outside the system. MANUAL_ACTION_REQUIRED → PROVISIONED with operator, timestamp, safe evidence,
 * audit and a provisioning wake. Refused for OKTA/GITHUB resources; never bypasses authorization.
 */
export const adminManualProvisioningRoutes: FastifyPluginAsync<
  AdminManualProvisioningRoutesOptions
> = async (app, { adminToken, manual }) => {
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    if (err.statusCode === 415) {
      return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
    }
    if (err.statusCode === 400 || err.statusCode === 413) {
      return reject(reply, 400, "INVALID_PAYLOAD", 'body must be {"evidence": "<short note>"}');
    }
    request.log.error({ err }, "manual completion failed");
    return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
  });
  const authorize = operatorAuthorizer(adminToken, (reply) =>
    reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
  );

  app.post<{ Params: { accessRequestId: string }; Body: unknown }>(
    "/admin/access-requests/:accessRequestId/manual-complete",
    { onRequest: authorize, bodyLimit: 4096 },
    async (request, reply) => {
      const operatorId = request.headers[OPERATOR_ID_HEADER];
      if (typeof operatorId !== "string" || !OPERATOR_ID_PATTERN.test(operatorId)) {
        return reject(reply, 400, "OPERATOR_ID_REQUIRED", `${OPERATOR_ID_HEADER} header required`);
      }
      const params = ParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reject(reply, 404, "ACCESS_REQUEST_NOT_FOUND", "access request not found");
      }
      const body = BodySchema.safeParse(request.body);
      if (!body.success) {
        return reject(reply, 400, "INVALID_PAYLOAD", 'body must be {"evidence": "<short note>"}');
      }
      try {
        const result = await manual.completeManualResource({
          accessRequestId: params.data.accessRequestId,
          operatorId,
          evidence: body.data.evidence,
        });
        return reply
          .code(200)
          .send({ ...result, provisionedAt: result.provisionedAt.toISOString() });
      } catch (err) {
        if (err instanceof ManualCompletionError) {
          const code = err.code === "INVALID_OPERATOR_ID" ? "OPERATOR_ID_REQUIRED" : err.code;
          return reject(reply, STATUS_OF[err.code], code, err.message);
        }
        throw err;
      }
    },
  );
};
