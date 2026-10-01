import { cookies } from "next/headers";
import { isProductionDeployment, loadWebConfig } from "@/lib/config";
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  isSameOriginPost,
  useSecureCookies,
  verifySessionValue,
} from "@/lib/operator-session";
import { revokeOperatorSession } from "@/lib/operator-session-api";

export const dynamic = "force-dynamic";

/**
 * Logout (M9): clears the session cookie and returns to the login page. (M10) It first revokes the
 * session server-side, so even a copy of the cookie is refused by the API from now on. If the
 * revocation can't be confirmed the operator is told the session may stay valid until it expires.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const config = loadWebConfig();
  const session = config.ONBOARDING_ADMIN_TOKEN
    ? verifySessionValue(
        (await cookies()).get(SESSION_COOKIE)?.value,
        config.ONBOARDING_ADMIN_TOKEN,
      )
    : null;
  const revoked = session ? await revokeOperatorSession(session) : true;
  return new Response(null, {
    status: 303,
    headers: {
      location: `/admin/onboarding/login?loggedOut=${revoked ? "1" : "unconfirmed"}`,
      "set-cookie": clearSessionCookieHeader(
        useSecureCookies(request, isProductionDeployment(config)),
      ),
      "cache-control": "no-store",
    },
  });
}
