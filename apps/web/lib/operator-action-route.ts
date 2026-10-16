import { cookies } from "next/headers";
import { MANUAL_RESULT_MESSAGES } from "./console-model";
import { loadWebConfig } from "./config";
import { LOGIN_PATH } from "./dashboard-auth";
import { postOperatorAction, type OperatorAction } from "./operator-actions-api";
import { SESSION_COOKIE, isSameOriginPost, verifySessionValue } from "./operator-session";

const redirectTo = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

const DONE: Record<OperatorAction, string> = {
  retry: "retried",
  "request-approval": "approval_requested",
};

/**
 * Shared form handler for the workflow page's M13 buttons: same-origin post + verified operator
 * session → the API action, called server-side with the server-only token and the session's
 * operator id. Returns to the workflow page with a fixed outcome code.
 */
export async function handleOperatorAction(
  request: Request,
  workflowId: string,
  accessRequestId: string,
  action: OperatorAction,
): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) return redirectTo(`${LOGIN_PATH}?error=unavailable`);
  const session = verifySessionValue(
    (await cookies()).get(SESSION_COOKIE)?.value,
    ONBOARDING_ADMIN_TOKEN,
  );
  if (!session) return redirectTo(LOGIN_PATH);
  const result = await postOperatorAction(accessRequestId, action, {
    adminToken: ONBOARDING_ADMIN_TOKEN,
    operatorId: session.operatorId,
    sessionNonce: session.nonce,
  });
  if (!result.ok && result.status === 401) return redirectTo(`${LOGIN_PATH}?error=expired`);
  const code = result.ok
    ? DONE[action]
    : result.body.error in MANUAL_RESULT_MESSAGES
      ? result.body.error
      : "INTERNAL_ERROR";
  const page = `/admin/onboarding/${encodeURIComponent(workflowId)}`;
  return redirectTo(`${page}?result=${encodeURIComponent(code)}`);
}
