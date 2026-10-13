import {
  ManualCompletionErrorResponseSchema,
  ManualCompletionResponseSchema,
  OPERATOR_SESSION_HEADER,
  type ManualCompletionErrorResponse,
  type ManualCompletionResponse,
} from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";
import { OPERATOR_ID_HEADER, type OperatorCaller } from "./github-identity-api";

export type ManualCompletionResult =
  | { ok: true; status: number; body: ManualCompletionResponse }
  | { ok: false; status: number; body: ManualCompletionErrorResponse };

const UNAVAILABLE: ManualCompletionErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};

/**
 * Server-side client for the API's M7C manual-completion route, used by the workflow page's
 * "Mark as done" form handler. The server-only token never reaches the browser.
 */
export async function completeManualResource(
  accessRequestId: string,
  caller: OperatorCaller,
  evidence: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManualCompletionResult> {
  if (!z.uuid().safeParse(accessRequestId).success) {
    return {
      ok: false,
      status: 404,
      body: { error: "ACCESS_REQUEST_NOT_FOUND", message: "Access request not found." },
    };
  }
  const url = new URL(
    `/admin/access-requests/${accessRequestId}/manual-complete`,
    loadWebConfig().API_BASE_URL,
  );
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${caller.adminToken}`,
        [OPERATOR_ID_HEADER]: caller.operatorId,
        [OPERATOR_SESSION_HEADER]: caller.sessionNonce,
      },
      body: JSON.stringify({ evidence }),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 502, body: UNAVAILABLE };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const body = ManualCompletionResponseSchema.safeParse(json);
    return body.success
      ? { ok: true, status: res.status, body: body.data }
      : { ok: false, status: 502, body: UNAVAILABLE };
  }
  const error = ManualCompletionErrorResponseSchema.safeParse(json);
  return { ok: false, status: res.status, body: error.success ? error.data : UNAVAILABLE };
}
