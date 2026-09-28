import {
  GitHubIdentityClaimResponseSchema,
  GitHubIdentityErrorResponseSchema,
  GitHubIdentityStatusSchema,
  type GitHubIdentityErrorResponse,
} from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";

/** The operator's self-declared id header (audit actor `hr:<id>`). */
export const OPERATOR_ID_HEADER = "x-operator-id";

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: GitHubIdentityErrorResponse };

const UNAVAILABLE: GitHubIdentityErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};

/**
 * Server-side client for the API's HR/operator GitHub identity routes. The web app holds no
 * operator credential: it forwards the operator's own Authorization header, unchanged.
 */
async function call<T>(
  schema: z.ZodType<T>,
  workflowId: string,
  authorization: string,
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
      headers: { ...init.headers, authorization },
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

export function fetchGitHubIdentity(workflowId: string, authorization: string, fetchImpl = fetch) {
  return call(GitHubIdentityStatusSchema, workflowId, authorization, { method: "GET" }, fetchImpl);
}

export function recordGitHubIdentity(
  workflowId: string,
  authorization: string,
  operatorId: string,
  githubLogin: unknown,
  fetchImpl = fetch,
) {
  return call(
    GitHubIdentityClaimResponseSchema,
    workflowId,
    authorization,
    {
      method: "POST",
      headers: { "content-type": "application/json", [OPERATOR_ID_HEADER]: operatorId },
      body: JSON.stringify({ githubLogin }),
    },
    fetchImpl,
  );
}
