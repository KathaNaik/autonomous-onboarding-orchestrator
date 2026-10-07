import { OperatorAccountError, type OperatorAccountService } from "@aoo/orchestrator";
import type { OperatorAccountErrorResponse } from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { operatorAuthorizer } from "./operator-auth.js";

export interface AdminOperatorAccountRoutesOptions {
  adminToken: string;
  accounts: OperatorAccountService;
}

function reject(
  reply: FastifyReply,
  status: number,
  error: OperatorAccountErrorResponse["error"],
  message: string,
) {
  return reply.code(status).send({ error, message } satisfies OperatorAccountErrorResponse);
}

const STATUS_OF: Record<OperatorAccountError["code"], number> = {
  INVALID_PAYLOAD: 400,
  ACCOUNT_UNAVAILABLE: 409,
  INVALID_CREDENTIALS: 401,
  SIGNUP_LIMIT_REACHED: 429,
};

/**
 * (M12) Operator accounts, called only by the web server (server-only bearer token; no operator
 * session exists yet at sign-up or sign-in):
 *   POST /admin/operator-accounts          { email, password } → 201 { operatorId }
 *   POST /admin/operator-accounts/sign-in  { email, password } → 200 { operatorId }
 * Passwords never appear in logs or responses (Fastify doesn't log bodies; errors name fields only).
 */
export const adminOperatorAccountRoutes: FastifyPluginAsync<
  AdminOperatorAccountRoutesOptions
> = async (app, { adminToken, accounts }) => {
  app.setErrorHandler(
    (err: { code?: string; statusCode?: number; name?: string }, request, reply) => {
      if (err instanceof OperatorAccountError) {
        return reject(reply, STATUS_OF[err.code], err.code, err.message);
      }
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.statusCode === 415) {
        return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "send JSON");
      }
      if (err.statusCode === 400 || err.statusCode === 413) {
        return reject(reply, 400, "INVALID_PAYLOAD", "invalid request body");
      }
      request.log.error({ errType: err.code ?? err.name ?? "Error" }, "operator account failed");
      return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
    },
  );
  app.addHook(
    "onRequest",
    operatorAuthorizer(adminToken, (reply) =>
      reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
    ),
  );

  app.post("/admin/operator-accounts", { bodyLimit: 1024 }, async (request, reply) => {
    const account = await accounts.signUp(request.body);
    request.log.info({ operatorId: account.operatorId }, "operator account created");
    return reply.code(201).send(account);
  });

  app.post("/admin/operator-accounts/sign-in", { bodyLimit: 1024 }, async (request, reply) => {
    const account = await accounts.signIn(request.body);
    request.log.info({ operatorId: account.operatorId }, "operator signed in");
    return reply.code(200).send(account);
  });
};
