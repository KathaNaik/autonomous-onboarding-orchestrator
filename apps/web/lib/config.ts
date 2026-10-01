import { z } from "zod";

const blankAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const WebEnvSchema = z.object({
  API_BASE_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:4000"),
  /**
   * (M9) The existing shared operator token, read ONLY on the server: it validates dashboard
   * logins, derives the session-signing key and authenticates the server-side calls to the API.
   * It is never sent to the browser. Unset: the operator dashboard is disabled.
   */
  ONBOARDING_ADMIN_TOKEN: z.preprocess(
    blankAsUnset,
    z.string().min(32, "ONBOARDING_ADMIN_TOKEN must be at least 32 characters").optional(),
  ),
  /** (M10) `production` (or Vercel's VERCEL_ENV=production) forces Secure session cookies. */
  AOO_ENVIRONMENT: z.preprocess(
    blankAsUnset,
    z.enum(["local", "preview", "production"]).default("local"),
  ),
  VERCEL_ENV: z.preprocess(blankAsUnset, z.string().optional()),
});

/** (M10) Production deployments always issue Secure cookies, whatever the request looked like. */
export function isProductionDeployment(
  config: Pick<ReturnType<typeof loadWebConfig>, "AOO_ENVIRONMENT" | "VERCEL_ENV">,
): boolean {
  return config.AOO_ENVIRONMENT === "production" || config.VERCEL_ENV === "production";
}

/** The only place the web app reads process.env (server-side). Errors name variables only. */
export function loadWebConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = WebEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid web configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  return parsed.data;
}
