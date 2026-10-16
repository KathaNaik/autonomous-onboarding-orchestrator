import {
  OPERATOR_SESSION_HEADER,
  OperatorActionErrorResponseSchema,
  RequestApprovalAgainResponseSchema,
  RetryResourceResponseSchema,
  type OperatorActionErrorResponse,
} from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";
import { OPERATOR_ID_HEADER, type OperatorCaller } from "./github-identity-api";

export type OperatorAction = "retry" | "request-approval";

export type OperatorActionResult =
  { ok: true; status: number } | { ok: false; status: number; body: OperatorActionErrorResponse };

const UNAVAILABLE: OperatorActionErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};

const SUCCESS = {
  retry: RetryResourceResponseSchema,
  "request-approval": RequestApprovalAgainResponseSchema,
} as const;

/**
 * Server-side client for the API's M13 operator actions (retry a failed tool; ask for a new
 * approval ticket). The server-only token never reaches the browser.
 */
export async function postOperatorAction(
  accessRequestId: string,
  action: OperatorAction,
  caller: OperatorCaller,
  fetchImpl: typeof fetch = fetch,
): Promise<OperatorActionResult> {
  if (!z.uuid().safeParse(accessRequestId).success) {
    return {
      ok: false,
      status: 404,
      body: { error: "ACCESS_REQUEST_NOT_FOUND", message: "Access request not found." },
    };
  }
  const url = new URL(
    `/admin/access-requests/${accessRequestId}/${action}`,
    loadWebConfig().API_BASE_URL,
  );
  let res: Response;
  try {
    // No body: the API takes the operator from the headers.
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
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
    return SUCCESS[action].safeParse(json).success
      ? { ok: true, status: res.status }
      : { ok: false, status: 502, body: UNAVAILABLE };
  }
  const error = OperatorActionErrorResponseSchema.safeParse(json);
  return { ok: false, status: res.status, body: error.success ? error.data : UNAVAILABLE };
}
