import {
  clearSessionCookieHeader,
  isSameOriginPost,
  isSecureRequest,
} from "@/lib/operator-session";

export const dynamic = "force-dynamic";

/** (M9) Logout: clears the session cookie and returns to the login page. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/admin/onboarding/login?loggedOut=1",
      "set-cookie": clearSessionCookieHeader(isSecureRequest(request)),
      "cache-control": "no-store",
    },
  });
}
