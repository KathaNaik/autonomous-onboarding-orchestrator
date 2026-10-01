import { OPERATOR_ID_PATTERN, ReadModelError, type WorkflowReadService } from "@aoo/orchestrator";
import {
  WorkflowListResponseSchema,
  WorkflowObservabilityViewSchema,
  type ObservabilityErrorResponse,
} from "@aoo/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  OPERATOR_ID_HEADER,
  operatorAuthorizer,
  type OperatorSessionCheck,
} from "./operator-auth.js";

export interface AdminOnboardingReadRoutesOptions {
  /** ONBOARDING_ADMIN_TOKEN: the existing shared operator bearer token (no second secret). */
  adminToken: string;
  /** (M10) Refuses logged-out dashboard sessions. */
  sessions?: OperatorSessionCheck;
  reads: WorkflowReadService;
}

function reject(
  reply: FastifyReply,
  status: number,
  error: ObservabilityErrorResponse["error"],
  message: string,
) {
  const body: ObservabilityErrorResponse = { error, message };
  return reply.code(status).send(body);
}

/**
 * (M9) Internal, read-only operator API for the dashboard:
 *   GET /admin/onboarding             recent workflows (keyset pagination, optional state filter)
 *   GET /admin/onboarding/:workflowId one composed observability view
 * `Authorization: Bearer <ONBOARDING_ADMIN_TOKEN>` is checked first (before any database access,
 * so unauthorized callers can't learn whether a workflow exists). `X-Operator-Id` is optional for
 * reads, as for the M7B status route; when present it must be valid and is logged (never written:
 * reads make no database writes). Responses are parsed through the M9 Zod DTOs, so only listed
 * fields ever leave. No stack traces in responses.
 */
export const adminOnboardingReadRoutes: FastifyPluginAsync<
  AdminOnboardingReadRoutesOptions
> = async (app, { adminToken, reads, sessions }) => {
  app.setErrorHandler((err: { code?: string; name?: string }, request, reply) => {
    request.log.error({ errType: err.code ?? err.name ?? "Error" }, "operator read failed");
    return reject(reply, 500, "INTERNAL_ERROR", "request failed; try again");
  });

  app.addHook(
    "onRequest",
    operatorAuthorizer(
      adminToken,
      (reply) => reject(reply, 401, "OPERATOR_UNAUTHORIZED", "operator authorization required"),
      sessions,
    ),
  );
  app.addHook("onRequest", async (request, reply) => {
    const operatorId = request.headers[OPERATOR_ID_HEADER];
    if (operatorId === undefined) return;
    if (typeof operatorId !== "string" || !OPERATOR_ID_PATTERN.test(operatorId)) {
      return reject(reply, 400, "OPERATOR_ID_INVALID", "X-Operator-Id is invalid");
    }
  });

  const operatorOf = (headers: Record<string, unknown>) =>
    typeof headers[OPERATOR_ID_HEADER] === "string"
      ? (headers[OPERATOR_ID_HEADER] as string)
      : null;

  app.get("/admin/onboarding", async (request, reply) => {
    try {
      const result = await reads.listWorkflows(request.query);
      request.log.info(
        { operatorId: operatorOf(request.headers), count: result.items.length },
        "operator listed workflows",
      );
      return reply.code(200).send(WorkflowListResponseSchema.parse(result));
    } catch (err) {
      if (err instanceof ReadModelError && err.code === "INVALID_QUERY") {
        return reject(reply, 400, "INVALID_QUERY", err.message);
      }
      throw err;
    }
  });

  app.get<{ Params: { workflowId: string } }>(
    "/admin/onboarding/:workflowId",
    async (request, reply) => {
      try {
        const view = await reads.getWorkflowObservabilityView(request.params.workflowId);
        request.log.info(
          { operatorId: operatorOf(request.headers), workflowId: view.workflow.workflowId },
          "operator viewed workflow",
        );
        return reply.code(200).send(WorkflowObservabilityViewSchema.parse(view));
      } catch (err) {
        if (err instanceof ReadModelError && err.code === "WORKFLOW_NOT_FOUND") {
          return reject(reply, 404, "WORKFLOW_NOT_FOUND", "workflow not found");
        }
        throw err;
      }
    },
  );
};
