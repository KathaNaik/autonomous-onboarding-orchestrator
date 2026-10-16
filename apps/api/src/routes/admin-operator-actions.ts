import {
  OPERATOR_ID_PATTERN,
  OperatorActionError,
  type OperatorActionService,
} from "@aoo/orchestrator";
import type { OperatorActionErrorResponse } from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  OPERATOR_ID_HEADER,
  operatorAuthorizer,
  type OperatorSessionCheck,
} from "./operator-auth.js";

export interface AdminOperatorActionsRoutesOptions {
  /** ONBOARDING_ADMIN_TOKEN (the M7B operator trust boundary). */
  adminToken: string;
  /** (M10) Refuses logged-out dashboard sessions. */
  sessions?: OperatorSessionCheck;
  actions: Pick<OperatorActionService, "retryFailedResource" | "requestApprovalAgain">;
}

const ParamsSchema = z.object({ accessRequestId: z.uuid() });

const STATUS_OF: Record<OperatorActionError["code"], number> = {
  OPERATOR_ID_REQUIRED: 400,
  ACCESS_REQUEST_NOT_FOUND: 404,
  NOT_FAILED: 409,
  NOT_AWAITING_APPROVAL: 409,
  NOT_IN_ACTIVE_PLAN: 409,
  WORKFLOW_NOT_ACTIVE: 409,
};

function reject(
  reply: FastifyReply,
  status: number,
  error: OperatorActionErrorResponse["error"],
  message: string,
) {
  const body: OperatorActionErrorResponse = { error, message };
  return reply.code(status).send(body);
}

/**
 * M13: operator actions on one resource. No body; the operator id comes from `X-Operator-Id`.
 *   POST /admin/access-requests/:id/retry             PROVISIONING_FAILED → retried
 *   POST /admin/access-requests/:id/request-approval  ask for a new approval ticket (checked by
 *                                                     the worker against ServiceNow first)
 */
export const adminOperatorActionsRoutes: FastifyPluginAsync<
  AdminOperatorActionsRoutesOptions
> = async (app, { adminToken, actions, sessions }) => {
  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, "operator action failed");
    return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
  });
  const authorize = operatorAuthorizer(
    adminToken,
    (reply) => reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
    sessions,
  );

  const route = (
    path: string,
    run: (input: { accessRequestId: string; operatorId: string }) => Promise<unknown>,
    status: number,
  ) =>
    app.post<{ Params: { accessRequestId: string } }>(
      path,
      { onRequest: authorize, bodyLimit: 1024 },
      async (request, reply) => {
        const operatorId = request.headers[OPERATOR_ID_HEADER];
        if (typeof operatorId !== "string" || !OPERATOR_ID_PATTERN.test(operatorId)) {
          return reject(
            reply,
            400,
            "OPERATOR_ID_REQUIRED",
            `${OPERATOR_ID_HEADER} header required`,
          );
        }
        const params = ParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reject(reply, 404, "ACCESS_REQUEST_NOT_FOUND", "access request not found");
        }
        try {
          const result = await run({ accessRequestId: params.data.accessRequestId, operatorId });
          request.log.info(
            { operatorId, accessRequestId: params.data.accessRequestId, action: path },
            "operator action accepted",
          );
          return reply.code(status).send(result);
        } catch (err) {
          if (err instanceof OperatorActionError) {
            return reject(reply, STATUS_OF[err.code], err.code, err.message);
          }
          throw err;
        }
      },
    );

  route(
    "/admin/access-requests/:accessRequestId/retry",
    (input) => actions.retryFailedResource(input),
    200,
  );
  route(
    "/admin/access-requests/:accessRequestId/request-approval",
    (input) => actions.requestApprovalAgain(input),
    202,
  );
};
