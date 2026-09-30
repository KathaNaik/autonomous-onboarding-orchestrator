import { z } from "zod";
import { createOpenAIProvider } from "./providers/openai.js";
import type { ModelProvider } from "./providers/types.js";

const RoleAccessAgentConfigSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  OPENAI_BASE_URL: z
    .url()
    .refine((u) => u.startsWith("https://"), "OPENAI_BASE_URL must be https")
    .transform((u) => u.replace(/\/+$/, ""))
    .default("https://api.openai.com"),
  ROLE_ACCESS_AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  ROLE_ACCESS_AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  /** max_output_tokens; generous because reasoning models spend output tokens on reasoning. */
  ROLE_ACCESS_AGENT_MAX_TOKENS: z.coerce.number().int().min(256).max(32_768).default(8192),
});
export type RoleAccessAgentConfig = z.infer<typeof RoleAccessAgentConfigSchema>;

/** Reads the agent configuration. Errors name the variable, never its value. */
export function loadRoleAccessAgentConfig(
  env: Record<string, string | undefined> = process.env,
): RoleAccessAgentConfig {
  const parsed = RoleAccessAgentConfigSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid Role Access Agent configuration: ${names}`);
  }
  return parsed.data;
}

export function createProviderFromConfig(config: RoleAccessAgentConfig): ModelProvider {
  return createOpenAIProvider({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
    model: config.OPENAI_MODEL,
    timeoutMs: config.ROLE_ACCESS_AGENT_TIMEOUT_MS,
    maxOutputTokens: config.ROLE_ACCESS_AGENT_MAX_TOKENS,
  });
}

/**
 * (M8) Onboarding Plan Agent configuration. Reuses the same OpenAI key, model and base URL as the
 * Role Access Agent (no second key); only the timeout, attempts and output-token limit are its own.
 */
const OnboardingPlanAgentConfigSchema = RoleAccessAgentConfigSchema.pick({
  OPENAI_API_KEY: true,
  OPENAI_MODEL: true,
  OPENAI_BASE_URL: true,
}).extend({
  ONBOARDING_PLAN_AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(90_000),
  ONBOARDING_PLAN_AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  ONBOARDING_PLAN_AGENT_MAX_TOKENS: z.coerce.number().int().min(256).max(32_768).default(8192),
});
export type OnboardingPlanAgentConfig = z.infer<typeof OnboardingPlanAgentConfigSchema>;

/** Reads the Onboarding Plan Agent configuration. Errors name the variable, never its value. */
export function loadOnboardingPlanAgentConfig(
  env: Record<string, string | undefined> = process.env,
): OnboardingPlanAgentConfig {
  const parsed = OnboardingPlanAgentConfigSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid Onboarding Plan Agent configuration: ${names}`);
  }
  return parsed.data;
}

export function createOnboardingPlanProviderFromConfig(
  config: OnboardingPlanAgentConfig,
): ModelProvider {
  return createOpenAIProvider({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
    model: config.OPENAI_MODEL,
    timeoutMs: config.ONBOARDING_PLAN_AGENT_TIMEOUT_MS,
    maxOutputTokens: config.ONBOARDING_PLAN_AGENT_MAX_TOKENS,
  });
}
