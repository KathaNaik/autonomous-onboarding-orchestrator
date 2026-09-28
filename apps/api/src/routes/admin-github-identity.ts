import {
  GitHubIdentityError,
  OPERATOR_ID_PATTERN,
  type GitHubIdentityService,
} from "@aoo/orchestrator";
import type { GitHubIdentityErrorResponse } from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { OPERATOR_ID_HEADER, operatorAuthorizer } from "./operator-auth.js";

export interface AdminGitHubIdentityRoutesOptions {
  /** ONBOARDING_ADMIN_TOKEN: the shared HR/onboarding operator bearer token. */
  adminToken: string;
  identities: GitHubIdentityService;
}

export { OPERATOR_ID_HEADER };

type Params = { workflowId: string };

function reject(
  reply: FastifyReply,
  status: number,
  error: GitHubIdentityErrorResponse["error"],
  message: string,
) {
  const body: GitHubIdentityErrorResponse = { error, message };
  return reply.code(status).send(body);
}

const STATUS_OF: Record<GitHubIdentityError["code"], number> = {
  INVALID_GITHUB_LOGIN: 400,
  INVALID_OPERATOR_ID: 400,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_NOT_ACTIVE: 409,
  GITHUB_IDENTITY_ALREADY_LINKED: 409,
};

/**
 * HR/onboarding operator routes (M7B): record the GitHub username the employee gave HR, and view
 * GitHub identity progress. Recording is identity data only: no policy decision, GitHub call,
 * ticket or provisioning. Every request needs `Authorization: Bearer <ONBOARDING_ADMIN_TOKEN>`,
 * checked before any database access. Employee-facing credentials are never accepted here.
 */
export const adminGitHubIdentityRoutes: FastifyPluginAsync<
  AdminGitHubIdentityRoutesOptions
> = async (app, { adminToken, identities }) => {
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    if (err.statusCode === 415) {
      return reject(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
    }
    if (err.statusCode === 400 || err.statusCode === 413) {
      return reject(reply, 400, "INVALID_PAYLOAD", "body must be a small JSON object");
    }
    request.log.error({ err }, "admin github identity failed");
    return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
  });

  // onRequest: before body parsing, so unauthenticated requests learn nothing about the payload.
  const authorize = operatorAuthorizer(adminToken, (reply) =>
    reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
  );

  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.code(200).send(await fn());
    } catch (err) {
      if (err instanceof GitHubIdentityError) {
        const code =
          err.code === "INVALID_GITHUB_LOGIN"
            ? "INVALID_PAYLOAD"
            : err.code === "INVALID_OPERATOR_ID"
              ? "OPERATOR_ID_REQUIRED"
              : err.code;
        return reject(reply, STATUS_OF[err.code], code, err.message);
      }
      throw err;
    }
  };

  app.get<{ Params: Params }>(
    "/admin/onboarding/:workflowId/github-identity",
    { onRequest: authorize },
    async (request, reply) => handle(reply, () => identities.getStatus(request.params.workflowId)),
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/admin/onboarding/:workflowId/github-identity",
    { onRequest: authorize, bodyLimit: 1024 },
    async (request, reply) => {
      const operatorId = request.headers[OPERATOR_ID_HEADER];
      if (typeof operatorId !== "string" || !OPERATOR_ID_PATTERN.test(operatorId)) {
        return reject(reply, 400, "OPERATOR_ID_REQUIRED", `${OPERATOR_ID_HEADER} header required`);
      }
      const body = request.body;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => k !== "githubLogin")
      ) {
        return reject(reply, 400, "INVALID_PAYLOAD", 'body must be {"githubLogin": "<username>"}');
      }
      const { githubLogin } = body as { githubLogin?: unknown };
      return handle(reply, () =>
        identities.submitClaim({ workflowId: request.params.workflowId, githubLogin, operatorId }),
      );
    },
  );
};
