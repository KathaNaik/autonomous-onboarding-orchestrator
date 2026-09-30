// Explicit live evaluation of the Onboarding Plan Agent (M8) against the real model provider.
// Run from the repo root: pnpm test:onboarding-plan:eval   (needs OPENAI_API_KEY in .env)
// Never part of pnpm check or pnpm test:integration. Without credentials it reports BLOCKED and
// exits non-zero; it never substitutes a test double. Synthetic cases only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  createOnboardingPlanProviderFromConfig,
  loadOnboardingPlanAgentConfig,
} from "../config.js";
import {
  ONBOARDING_PLAN_EVAL_CASES,
  ONBOARDING_PLAN_EVAL_CATALOG_VERSION,
  evalCaseInput,
} from "../eval/onboarding-plan-dataset.js";
import {
  scoreOnboardingPlanEval,
  type OnboardingPlanEvalObservation,
} from "../eval/onboarding-plan-metrics.js";
import { OnboardingPlanAgentError, createOnboardingPlanAgent } from "../onboarding-plan/agent.js";
import { ONBOARDING_PLAN_PROMPT_VERSION } from "../onboarding-plan/prompt.js";
import type { ModelProvider } from "../providers/types.js";

// The repo-root .env (git-ignored) holds the credentials; it is never printed.
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadOnboardingPlanAgentConfig();
} catch (err) {
  console.error(`BLOCKED: live evaluation needs model credentials (${(err as Error).message}).`);
  process.exit(2);
}

const catalog = loadCatalogRegistry().get(ONBOARDING_PLAN_EVAL_CATALOG_VERSION);
const catalogResourceIds = catalog.resources.map((r) => r.resourceId);
const real = createOnboardingPlanProviderFromConfig(config);
let lastRaw: unknown;
let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
const servedModels = new Set<string>();
const provider: ModelProvider = {
  provider: real.provider,
  model: real.model,
  configId: real.configId,
  async generate(request, options) {
    const response = await real.generate(request, options);
    lastRaw = response.output;
    lastUsage = response.usage;
    if (response.model) servedModels.add(response.model);
    return response;
  },
};
// One model call per case: the raw answer is scored as produced (no retry can mask it).
const agent = createOnboardingPlanAgent({ provider, maxAttempts: 1 });
const showPlans = process.argv.includes("--show-plans");

const observations: OnboardingPlanEvalObservation[] = [];
const plans: Record<string, unknown> = {};
for (const evalCase of ONBOARDING_PLAN_EVAL_CASES) {
  lastRaw = undefined;
  lastUsage = undefined;
  const input = evalCaseInput(evalCase, catalog);
  const started = performance.now();
  let outcome = "ok";
  try {
    await agent.generate({ modelInput: input, catalogResourceIds });
  } catch (err) {
    outcome = err instanceof OnboardingPlanAgentError ? err.category : "INTERNAL";
  }
  observations.push({
    case: evalCase,
    input,
    catalogResourceIds,
    rawOutput: lastRaw,
    outcome,
    latencyMs: Math.round(performance.now() - started),
    usage: lastUsage,
  });
  if (showPlans) plans[evalCase.id] = lastRaw;
  console.error(`case ${evalCase.id}: ${outcome}`);
}

const report = scoreOnboardingPlanEval(observations);
console.log(
  JSON.stringify(
    {
      provider: real.provider,
      model: real.model,
      modelConfig: real.configId,
      servedModels: [...servedModels].sort(),
      promptVersion: ONBOARDING_PLAN_PROMPT_VERSION,
      catalogVersion: catalog.catalogVersion,
      catalogHash: catalog.catalogHash,
      ...report,
      ...(showPlans && { plans }),
    },
    null,
    2,
  ),
);
process.exitCode = report.passed ? 0 : 1;
