import { isProductionDeployment, loadWebConfig } from "@/lib/config";
import { credentialsFrom, signInOperator } from "@/lib/operator-accounts-api";
import {
  createSessionValue,
  isSameOriginPost,
  sessionCookieHeader,
  useSecureCookies,
} from "@/lib/operator-session";

export const dynamic = "force-dynamic";

const redirectTo = (path: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    status: 303,
    headers: { location: path, "cache-control": "no-store", ...extra },
  });

/**
 * Dashboard sign-in. (M12) A plain HTML form posts the operator's email and password here; the
 * API checks them against the operator's account (the shared token is no longer a sign-in
 * credential). The password is never stored or logged by the web server; the browser gets only a
 * short-lived HttpOnly session cookie whose operator id is the account email. Failures are generic.
 * Cross-site posts are refused.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) {
    return redirectTo("/admin/onboarding/login?error=unavailable");
  }
  const credentials = credentialsFrom(await request.formData().catch(() => null));
  if (!credentials.email || !credentials.password) {
    return redirectTo("/admin/onboarding/login?error=unauthorized");
  }
  const result = await signInOperator(credentials);
  if (!result.ok) {
    return redirectTo(
      `/admin/onboarding/login?error=${result.status >= 500 ? "unavailable" : "unauthorized"}`,
    );
  }
  const cookie = sessionCookieHeader(
    createSessionValue(result.operatorId, config.ONBOARDING_ADMIN_TOKEN),
    useSecureCookies(request, isProductionDeployment(config)),
  );
  return redirectTo("/admin/onboarding", { "set-cookie": cookie });
}
