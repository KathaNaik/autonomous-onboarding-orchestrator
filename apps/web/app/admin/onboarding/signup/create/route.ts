import { isProductionDeployment, loadWebConfig } from "@/lib/config";
import { credentialsFrom, signUpOperator } from "@/lib/operator-accounts-api";
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
const back = (code: string) =>
  redirectTo(`/admin/onboarding/signup?error=${encodeURIComponent(code)}`);

/**
 * (M12) Account creation: same-origin form post → the API creates the account (hashed password,
 * daily sign-up cap) → the operator is signed in straight away with the usual session cookie.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) return back("unavailable");
  const form = await request.formData().catch(() => null);
  const credentials = credentialsFrom(form);
  if (credentials.password !== form?.get("confirm")) return back("PASSWORD_MISMATCH");
  const result = await signUpOperator(credentials);
  if (!result.ok) {
    return back(
      ["INVALID_PAYLOAD", "ACCOUNT_UNAVAILABLE", "SIGNUP_LIMIT_REACHED"].includes(result.error)
        ? result.error
        : "unavailable",
    );
  }
  const cookie = sessionCookieHeader(
    createSessionValue(result.operatorId, config.ONBOARDING_ADMIN_TOKEN),
    useSecureCookies(request, isProductionDeployment(config)),
  );
  return redirectTo("/admin/onboarding", { "set-cookie": cookie });
}
