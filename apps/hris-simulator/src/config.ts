import { z } from "zod";

const EnvSchema = z.object({
  HRIS_WEBHOOK_URL: z.url().default("http://localhost:4000/webhooks/hris"),
  HRIS_WEBHOOK_SECRET: z.string().min(32, "HRIS_WEBHOOK_SECRET must be at least 32 characters"),
});

export type SimulatorConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SimulatorConfig {
  return EnvSchema.parse(env);
}
