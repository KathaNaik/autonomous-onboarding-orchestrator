import { cookies } from "next/headers";
import { MANUAL_RESULT_MESSAGES } from "@/lib/console-model";
import { loadWebConfig } from "@/lib/config";
import { LOGIN_PATH } from "@/lib/dashboard-auth";
import { completeManualResource } from "@/lib/manual-provisioning-api";
import { SESSION_COOKIE, isSameOriginPost, verifySessionValue } from "@/lib/operator-session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workflowId: string; accessRequestId: string }> };

const redirectTo = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/**
 * "Mark as done" for a provider=MANUAL tool: same-origin form post + verified operator session →
 * the API's M7C manual-completion route, called server-side with the server-only token and the
 * session's operator id. Returns to the workflow page with a fixed outcome code.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) return redirectTo(`${LOGIN_PATH}?error=unavailable`);
  const session = verifySessionValue(
    (await cookies()).get(SESSION_COOKIE)?.value,
    ONBOARDING_ADMIN_TOKEN,
  );
  if (!session) return redirectTo(LOGIN_PATH);
  const { workflowId, accessRequestId } = await params;
  const form = await request.formData().catch(() => null);
  const evidence = form?.get("evidence");
  const result = await completeManualResource(
    accessRequestId,
    {
      adminToken: ONBOARDING_ADMIN_TOKEN,
      operatorId: session.operatorId,
      sessionNonce: session.nonce,
    },
    typeof evidence === "string" ? evidence : "",
  );
  if (!result.ok && result.status === 401) return redirectTo(`${LOGIN_PATH}?error=expired`);
  const code = result.ok
    ? result.body.changed
      ? "done"
      : "unchanged"
    : result.body.error in MANUAL_RESULT_MESSAGES
      ? result.body.error
      : "INTERNAL_ERROR";
  const page = `/admin/onboarding/${encodeURIComponent(workflowId)}`;
  return redirectTo(`${page}?result=${encodeURIComponent(code)}`);
}
