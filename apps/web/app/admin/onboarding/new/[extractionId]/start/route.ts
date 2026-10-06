import { cookies } from "next/headers";
import { loadWebConfig } from "@/lib/config";
import { LOGIN_PATH } from "@/lib/dashboard-auth";
import { startOnboardingFromOffer } from "@/lib/offer-letter-api";
import { SESSION_COOKIE, isSameOriginPost, verifySessionValue } from "@/lib/operator-session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ extractionId: string }> };

const redirectTo = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

const TEXT_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "role",
  "department",
  "managerId",
  "departmentCode",
  "roleFamilyCode",
  "employmentType",
] as const;

/**
 * (M11) Start handler: same-origin post + verified session → the API with only the listed fields
 * (anything else in the form is ignored). The attestation is true only when the box was ticked.
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
  const { extractionId } = await params;
  const form = await request.formData().catch(() => null);
  const body: Record<string, unknown> = {};
  for (const name of TEXT_FIELDS) {
    const v = form?.get(name);
    body[name] = typeof v === "string" ? v.trim() : "";
  }
  const description = form?.get("jobDescription");
  if (typeof description === "string" && description.trim())
    body.jobDescription = description.trim();
  // No attestation, no call: an onboarding never starts unless the operator ticked the box.
  if (form?.get("offerSignedAndCleared") !== "true") {
    return redirectTo(
      `/admin/onboarding/new/${encodeURIComponent(extractionId)}?error=ATTESTATION_REQUIRED`,
    );
  }
  body.offerSignedAndCleared = true;
  const result = await startOnboardingFromOffer(extractionId, body, session);
  if (result.ok) return redirectTo(`/admin/onboarding/${result.body.workflowId}`);
  if (result.status === 401) return redirectTo(`${LOGIN_PATH}?error=expired`);
  const page = `/admin/onboarding/new/${encodeURIComponent(extractionId)}`;
  return redirectTo(`${page}?error=${encodeURIComponent(result.body.error)}`);
}
