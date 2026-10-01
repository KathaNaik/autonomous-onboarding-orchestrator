import {
  GitHubIdentityClaimResponseSchema,
  GitHubIdentityErrorResponseSchema,
  GitHubIdentityStatusSchema,
  type GitHubIdentityErrorResponse,
} from "@aoo/shared";
import { OPERATOR_SESSION_HEADER } from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";

/** The operator's id header (audit actor `hr:<id>`), taken from the verified session. */
export const OPERATOR_ID_HEADER = "x-operator-id";

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: GitHubIdentityErrorResponse };

/** Server-side caller identity: the server-only token plus the session's operator id. */
export interface OperatorCaller {
  adminToken: string;
  operatorId: string;
  /** (M10) The session nonce; the API refuses it after logout. */
  sessionNonce: string;
}

const UNAVAILABLE: GitHubIdentityErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};

/**
 * (M10) Server-side client for the API's HR/operator GitHub identity routes, used by the
 * session-protected HR page and its form handler. Like the M9 dashboard, the shared operator
 * token stays on the server: the browser only holds the HttpOnly session cookie.
 */
async function call<T>(
  schema: z.ZodType<T>,
  workflowId: string,
  caller: OperatorCaller,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<ApiResult<T>> {
  if (!z.uuid().safeParse(workflowId).success) {
    return {
      ok: false,
      status: 404,
      body: { error: "WORKFLOW_NOT_FOUND", message: "Onboarding not found." },
    };
  }
  const url = new URL(
    `/admin/onboarding/${workflowId}/github-identity`,
    loadWebConfig().API_BASE_URL,
  );
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${caller.adminToken}`,
        [OPERATOR_ID_HEADER]: caller.operatorId,
        [OPERATOR_SESSION_HEADER]: caller.sessionNonce,
      },
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 502, body: UNAVAILABLE };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const body = schema.safeParse(json);
    return body.success
      ? { ok: true, status: res.status, body: body.data }
      : { ok: false, status: 502, body: UNAVAILABLE };
  }
  const error = GitHubIdentityErrorResponseSchema.safeParse(json);
  return { ok: false, status: res.status, body: error.success ? error.data : UNAVAILABLE };
}

export function fetchGitHubIdentity(workflowId: string, caller: OperatorCaller, fetchImpl = fetch) {
  return call(GitHubIdentityStatusSchema, workflowId, caller, { method: "GET" }, fetchImpl);
}

export function recordGitHubIdentity(
  workflowId: string,
  caller: OperatorCaller,
  githubLogin: unknown,
  fetchImpl = fetch,
) {
  return call(
    GitHubIdentityClaimResponseSchema,
    workflowId,
    caller,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubLogin }),
    },
    fetchImpl,
  );
}
