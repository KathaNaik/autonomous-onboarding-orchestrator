import type { OperatorSessionService } from "@aoo/orchestrator";
import { OperatorSessionRevokeRequestSchema, type ObservabilityErrorResponse } from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { OPERATOR_ID_HEADER, operatorAuthorizer } from "./operator-auth.js";

export interface AdminOperatorSessionRoutesOptions {
  adminToken: string;
  sessions: OperatorSessionService;
}

const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function reject(
  reply: FastifyReply,
  status: number,
  error: ObservabilityErrorResponse["error"],
  message: string,
) {
  return reply.code(status).send({ error, message } satisfies ObservabilityErrorResponse);
}

/**
 * (M10) POST /admin/operator-sessions/revoke: called by the web server at logout. Same operator
 * authorization as every admin route (checked before body parsing). Body exactly
 * `{ sessionNonce, expiresAt }`; idempotent.
 */
export const adminOperatorSessionRoutes: FastifyPluginAsync<
  AdminOperatorSessionRoutesOptions
> = async (app, { adminToken, sessions }) => {
  app.setErrorHandler((err: { code?: string; name?: string }, request, reply) => {
    request.log.error({ errType: err.code ?? err.name ?? "Error" }, "session revoke failed");
    return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
  });
  app.addHook(
    "onRequest",
    operatorAuthorizer(adminToken, (reply) =>
      reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
    ),
  );

  app.post("/admin/operator-sessions/revoke", { bodyLimit: 1024 }, async (request, reply) => {
    const operatorId = request.headers[OPERATOR_ID_HEADER];
    if (typeof operatorId !== "string" || !OPERATOR_ID_PATTERN.test(operatorId)) {
      return reject(reply, 400, "OPERATOR_ID_INVALID", "X-Operator-Id is required");
    }
    const parsed = OperatorSessionRevokeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reject(reply, 400, "INVALID_PAYLOAD", "invalid revoke request");
    await sessions.revoke({
      sessionNonce: parsed.data.sessionNonce,
      operatorId,
      expiresAt: new Date(parsed.data.expiresAt),
    });
    request.log.info({ operatorId }, "operator session revoked");
    return reply.code(200).send({ revoked: true });
  });
};
