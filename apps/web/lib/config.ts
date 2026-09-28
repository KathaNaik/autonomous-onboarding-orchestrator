import { z } from "zod";

const WebEnvSchema = z.object({
  API_BASE_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:4000"),
});

/** The only place the web app reads process.env (server-side). */
export function loadWebConfig(env: Record<string, string | undefined> = process.env) {
  return WebEnvSchema.parse(env);
}
