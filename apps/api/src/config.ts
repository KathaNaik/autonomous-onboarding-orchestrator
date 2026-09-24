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
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = EnvSchema.parse(env);
  // The callback secret must never double as a ServiceNow API credential.
  const apiPasswords = [env.SERVICENOW_PASSWORD, env.SERVICENOW_SCHEMA_PASSWORD].filter(Boolean);
  if (
    config.SERVICENOW_CALLBACK_SECRET &&
    apiPasswords.includes(config.SERVICENOW_CALLBACK_SECRET)
  ) {
    throw new Error("SERVICENOW_CALLBACK_SECRET must not reuse a ServiceNow API password");
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
