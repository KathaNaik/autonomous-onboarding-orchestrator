import { OperatorSessionRevokeResponseSchema } from "@aoo/shared";
import { loadWebConfig } from "./config";
import type { OperatorSession } from "./operator-session";

/**
 * (M10) Server-side logout: asks the API to revoke this session's nonce, so a copied cookie stops
 * working immediately instead of at its expiry. Server-only (the admin token never leaves).
 */
export async function revokeOperatorSession(
  session: OperatorSession,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) return false;
  try {
    const res = await fetchImpl(new URL("/admin/operator-sessions/revoke", config.API_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ONBOARDING_ADMIN_TOKEN}`,
        "x-operator-id": session.operatorId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionNonce: session.nonce,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      }),
      cache: "no-store",
      redirect: "error",
    });
    return res.ok && OperatorSessionRevokeResponseSchema.safeParse(await res.json()).success;
  } catch {
    return false;
  }
}
