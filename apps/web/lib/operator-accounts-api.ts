import {
  OperatorAccountErrorResponseSchema,
  OperatorAccountResponseSchema,
  type OperatorAccountErrorResponse,
} from "@aoo/shared";
import { loadWebConfig } from "./config";

export type AccountResult =
  | { ok: true; operatorId: string }
  | { ok: false; status: number; error: OperatorAccountErrorResponse["error"] };

/**
 * (M12) Server-side client for the API's operator-account routes. Runs only on the Next.js server
 * with the server-only token; the password goes from the form handler straight to the API and is
 * never stored, logged or returned by the web server.
 */
async function post(
  path: string,
  credentials: { email: string; password: string },
  fetchImpl: typeof fetch,
): Promise<AccountResult> {
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) return { ok: false, status: 503, error: "INTERNAL_ERROR" };
  let res: Response;
  try {
    res = await fetchImpl(new URL(path, config.API_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ONBOARDING_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(credentials),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 502, error: "INTERNAL_ERROR" };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const body = OperatorAccountResponseSchema.safeParse(json);
    return body.success
      ? { ok: true, operatorId: body.data.operatorId }
      : { ok: false, status: 502, error: "INTERNAL_ERROR" };
  }
  const error = OperatorAccountErrorResponseSchema.safeParse(json);
  return {
    ok: false,
    status: res.status,
    error: error.success ? error.data.error : "INTERNAL_ERROR",
  };
}

export const signUpOperator = (
  credentials: { email: string; password: string },
  fetchImpl: typeof fetch = fetch,
) => post("/admin/operator-accounts", credentials, fetchImpl);

export const signInOperator = (
  credentials: { email: string; password: string },
  fetchImpl: typeof fetch = fetch,
) => post("/admin/operator-accounts/sign-in", credentials, fetchImpl);

/** Reads the email and password fields of a posted form (anything else is ignored). */
export function credentialsFrom(form: FormData | null) {
  const email = form?.get("email");
  const password = form?.get("password");
  return {
    email: typeof email === "string" ? email.trim() : "",
    password: typeof password === "string" ? password : "",
  };
}
