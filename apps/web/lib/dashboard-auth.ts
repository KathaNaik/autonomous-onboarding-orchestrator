import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadWebConfig } from "./config";
import { SESSION_COOKIE, verifySessionValue, type OperatorSession } from "./operator-session";

export const LOGIN_PATH = "/admin/onboarding/login";

/**
 * (M9) Server components only: the verified operator session, or a redirect to the login page.
 * Missing, tampered and expired sessions are treated the same (no detail is revealed).
 */
export async function requireOperatorSession(): Promise<OperatorSession> {
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) redirect(`${LOGIN_PATH}?error=unavailable`);
  const session = verifySessionValue(
    (await cookies()).get(SESSION_COOKIE)?.value,
    ONBOARDING_ADMIN_TOKEN,
  );
  if (!session) redirect(LOGIN_PATH);
  return session;
}

/** The session if valid, else null (no redirect). */
export async function currentOperatorSession(): Promise<OperatorSession | null> {
  const { ONBOARDING_ADMIN_TOKEN } = loadWebConfig();
  if (!ONBOARDING_ADMIN_TOKEN) return null;
  return verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value, ONBOARDING_ADMIN_TOKEN);
}
