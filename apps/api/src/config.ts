import { loadOfferLetterAgentConfig, type OfferLetterAgentConfig } from "@aoo/agents";
import { z } from "zod";

const optional = (schema: z.ZodString) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional(),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    HRIS_WEBHOOK_SECRET: z.string().min(32, "HRIS_WEBHOOK_SECRET must be at least 32 characters"),
    HRIS_WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(65_536),
    /** (M10) Replay window for the HRIS X-AOO-Timestamp header. */
    HRIS_WEBHOOK_MAX_SKEW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
    /**
     * (M10) Deployment environment. `production` (or Vercel's VERCEL_ENV=production) refuses
     * the public development-only default secrets.
     */
    AOO_ENVIRONMENT: z.enum(["local", "preview", "production"]).default("local"),
    /**
     * (M11) Offer-letter intake for signed-in operators (uploads go to the Offer Letter Extractor,
     * i.e. OpenAI). Off by default; when on, OPENAI_API_KEY is required.
     */
    OFFER_LETTER_INTAKE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** (M12) Caps: new self-registered accounts and model-reaching offer-letter uploads per 24 h. */
    OPERATOR_SIGNUP_DAILY_LIMIT: z.coerce.number().int().min(0).max(10_000).default(20),
    OFFER_LETTER_DAILY_LIMIT_PER_OPERATOR: z.coerce.number().int().min(0).max(1000).default(3),
    OFFER_LETTER_DAILY_LIMIT_TOTAL: z.coerce.number().int().min(0).max(10_000).default(30),
    VERCEL_ENV: optional(z.string()),
    // ServiceNow approval callbacks (M4C). All three set = enabled; none set = endpoint absent.
    SERVICENOW_CALLBACK_SECRET: optional(
      z.string().min(32, "SERVICENOW_CALLBACK_SECRET must be at least 32 characters"),
    ),
    SERVICENOW_CALLBACK_INSTANCE: optional(
      z.string().regex(/^[a-z0-9-]+$/, "instance name, e.g. dev225201"),
    ),
    SERVICENOW_CALLBACK_TABLE: optional(z.string().regex(/^x_[a-z0-9_]+$/, "scoped table name")),
    SERVICENOW_CALLBACK_MAX_SKEW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .default(300_000),
    /**
     * (M7B) Bearer token for the HR/onboarding operator routes (recording GitHub usernames).
     * Unset: those routes are not registered. Dedicated: not the HRIS or callback secret.
     */
    ONBOARDING_ADMIN_TOKEN: optional(
      z.string().min(32, "ONBOARDING_ADMIN_TOKEN must be at least 32 characters"),
    ),
  })
  .refine(
    (c) =>
      [
        c.SERVICENOW_CALLBACK_SECRET,
        c.SERVICENOW_CALLBACK_INSTANCE,
        c.SERVICENOW_CALLBACK_TABLE,
      ].every((v) => v === undefined) ||
      [
        c.SERVICENOW_CALLBACK_SECRET,
        c.SERVICENOW_CALLBACK_INSTANCE,
        c.SERVICENOW_CALLBACK_TABLE,
      ].every((v) => v !== undefined),
    {
      message:
        "set SERVICENOW_CALLBACK_SECRET, SERVICENOW_CALLBACK_INSTANCE and SERVICENOW_CALLBACK_TABLE together",
      path: ["SERVICENOW_CALLBACK_SECRET"],
    },
  )
  .refine((c) => c.SERVICENOW_CALLBACK_SECRET !== c.HRIS_WEBHOOK_SECRET, {
    message: "SERVICENOW_CALLBACK_SECRET must differ from HRIS_WEBHOOK_SECRET",
    path: ["SERVICENOW_CALLBACK_SECRET"],
  })
  .refine(
    (c) =>
      !c.ONBOARDING_ADMIN_TOKEN ||
      (c.ONBOARDING_ADMIN_TOKEN !== c.HRIS_WEBHOOK_SECRET &&
        c.ONBOARDING_ADMIN_TOKEN !== c.SERVICENOW_CALLBACK_SECRET),
    {
      message: "ONBOARDING_ADMIN_TOKEN must differ from the HRIS and ServiceNow callback secrets",
      path: ["ONBOARDING_ADMIN_TOKEN"],
    },
  );

export type Config = z.infer<typeof EnvSchema> & {
  /** (M11) Present only when OFFER_LETTER_INTAKE_ENABLED=true. */
  offerLetterAgent?: OfferLetterAgentConfig;
};

/** Public, committed development defaults (docker-compose, .env.example): never valid in production. */
export const DEVELOPMENT_ONLY_SECRET = /^dev-only-/;

export function isProductionDeployment(config: Pick<Config, "AOO_ENVIRONMENT" | "VERCEL_ENV">) {
  return config.AOO_ENVIRONMENT === "production" || config.VERCEL_ENV === "production";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = EnvSchema.parse(env);
  if (isProductionDeployment(config)) {
    const leaked = (
      [
        ["HRIS_WEBHOOK_SECRET", config.HRIS_WEBHOOK_SECRET],
        ["ONBOARDING_ADMIN_TOKEN", config.ONBOARDING_ADMIN_TOKEN],
        ["SERVICENOW_CALLBACK_SECRET", config.SERVICENOW_CALLBACK_SECRET],
      ] as const
    ).filter(([, value]) => value !== undefined && DEVELOPMENT_ONLY_SECRET.test(value));
    if (leaked.length > 0) {
      // Names only, never values.
      throw new Error(
        `production refuses development-only default secrets: ${leaked.map(([n]) => n).join(", ")}`,
      );
    }
  }
  // The callback secret must never double as a ServiceNow API credential.
  const apiPasswords = [env.SERVICENOW_PASSWORD, env.SERVICENOW_SCHEMA_PASSWORD].filter(Boolean);
  if (
    config.SERVICENOW_CALLBACK_SECRET &&
    apiPasswords.includes(config.SERVICENOW_CALLBACK_SECRET)
  ) {
    throw new Error("SERVICENOW_CALLBACK_SECRET must not reuse a ServiceNow API password");
  }
  if (config.ONBOARDING_ADMIN_TOKEN && apiPasswords.includes(config.ONBOARDING_ADMIN_TOKEN)) {
    throw new Error("ONBOARDING_ADMIN_TOKEN must not reuse a ServiceNow API password");
  }
  if (config.OFFER_LETTER_INTAKE_ENABLED) {
    // Names a missing or invalid variable only, never a value.
    return { ...config, offerLetterAgent: loadOfferLetterAgentConfig(env) };
  }
  return config;
}

export function callbackConfig(config: Config) {
  return config.SERVICENOW_CALLBACK_SECRET &&
    config.SERVICENOW_CALLBACK_INSTANCE &&
    config.SERVICENOW_CALLBACK_TABLE
    ? {
        secret: config.SERVICENOW_CALLBACK_SECRET,
        instance: config.SERVICENOW_CALLBACK_INSTANCE,
        table: config.SERVICENOW_CALLBACK_TABLE,
        maxSkewMs: config.SERVICENOW_CALLBACK_MAX_SKEW_MS,
      }
    : null;
}
