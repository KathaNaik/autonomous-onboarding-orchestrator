import { cookies } from "next/headers";
import { loadWebConfig } from "@/lib/config";
import { LOGIN_PATH } from "@/lib/dashboard-auth";
import { recordGitHubIdentity } from "@/lib/github-identity-api";
import { RESULT_MESSAGES } from "@/lib/github-identity-status";
import { SESSION_COOKIE, isSameOriginPost, verifySessionValue } from "@/lib/operator-session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workflowId: string }> };

const redirectTo = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/**
 * (M10) HR form handler: same-origin form post + verified operator session → the API's
 * HR-identity route, called server-side with the server-only token and the session's operator
 * id. Returns to the page with a fixed outcome code; nothing secret is echoed.
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
  const { workflowId } = await params;
  const form = await request.formData().catch(() => null);
  const login = form?.get("githubLogin");
  const result = await recordGitHubIdentity(
    workflowId,
    {
      adminToken: ONBOARDING_ADMIN_TOKEN,
      operatorId: session.operatorId,
      sessionNonce: session.nonce,
    },
    typeof login === "string" ? login : "",
  );
  if (!result.ok && result.status === 401) return redirectTo(`${LOGIN_PATH}?error=expired`);
  const code = result.ok
    ? result.body.changed
      ? "saved"
      : "unchanged"
    : result.body.error in RESULT_MESSAGES
      ? result.body.error
      : "INTERNAL_ERROR";
  const page = `/admin/onboarding/${encodeURIComponent(workflowId)}/github`;
  return redirectTo(`${page}?result=${encodeURIComponent(code)}`);
}
