import { z } from "zod";

const DatabaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type DatabaseConfig = z.infer<typeof DatabaseEnvSchema>;

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return DatabaseEnvSchema.parse(env);
}
