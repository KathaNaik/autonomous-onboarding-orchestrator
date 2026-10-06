import { cookies } from "next/headers";
import { loadWebConfig } from "@/lib/config";
import { LOGIN_PATH } from "@/lib/dashboard-auth";
import { looksLikePdf, OFFER_LETTER_MAX_BYTES, uploadOfferLetter } from "@/lib/offer-letter-api";
import { SESSION_COOKIE, isSameOriginPost, verifySessionValue } from "@/lib/operator-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const redirectTo = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
const back = (code: string) =>
  redirectTo(`/admin/onboarding/new?error=${encodeURIComponent(code)}`);

/**
 * (M11) Upload handler: same-origin form post + verified operator session → the API (server-only
 * token, session operator and nonce). The file is checked here too (type, size, PDF signature)
 * before it leaves the web server; nothing is stored here.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) return new Response("Forbidden", { status: 403 });
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) return redirectTo(`${LOGIN_PATH}?error=unavailable`);
  const session = verifySessionValue(
    (await cookies()).get(SESSION_COOKIE)?.value,
    ONBOARDING_ADMIN_TOKEN,
  );
  if (!session) return redirectTo(LOGIN_PATH);
  const form = await request.formData().catch(() => null);
  const file = form?.get("offerLetter");
  if (!(file instanceof File) || file.size === 0) return back("NO_FILE");
  if (file.size > OFFER_LETTER_MAX_BYTES) return back("PAYLOAD_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) return back("INVALID_DOCUMENT");
  const result = await uploadOfferLetter(bytes, session);
  if (result.ok) return redirectTo(`/admin/onboarding/new/${result.body.extractionId}`);
  if (result.status === 401) return redirectTo(`${LOGIN_PATH}?error=expired`);
  return back(result.body.error);
}
