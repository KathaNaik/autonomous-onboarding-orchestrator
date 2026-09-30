import { loadWebConfig } from "@/lib/config";
import {
  OPERATOR_ID_PATTERN,
  createSessionValue,
  isSameOriginPost,
  isSecureRequest,
  isValidAdminToken,
  sessionCookieHeader,
} from "@/lib/operator-session";

export const dynamic = "force-dynamic";

const redirectTo = (path: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    status: 303,
    headers: { location: path, "cache-control": "no-store", ...extra },
  });

/**
 * (M9) Dashboard login: a plain HTML form posts the shared operator token and the operator id
 * here. The token is checked server-side (constant time) and discarded; the browser gets only a
 * short-lived HttpOnly session cookie. Failures are generic. Cross-site posts are refused.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) return redirectTo("/admin/onboarding/login?error=unavailable");
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  const operatorId = form?.get("operatorId");
  if (
    typeof operatorId !== "string" ||
    !OPERATOR_ID_PATTERN.test(operatorId.trim()) ||
    !isValidAdminToken(token, ONBOARDING_ADMIN_TOKEN)
  ) {
    return redirectTo("/admin/onboarding/login?error=unauthorized");
  }
  const cookie = sessionCookieHeader(
    createSessionValue(operatorId.trim(), ONBOARDING_ADMIN_TOKEN),
    isSecureRequest(request),
  );
  return redirectTo("/admin/onboarding", { "set-cookie": cookie });
}
