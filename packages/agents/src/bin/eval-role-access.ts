// Explicit live evaluation of the Role Access Agent against the real model provider.
// Run from the repo root: pnpm agent:eval:live   (needs OPENAI_API_KEY in .env)
// Never part of pnpm check or pnpm test:integration. Without credentials it reports BLOCKED
// and exits non-zero; it never substitutes a test double.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalogRegistry } from "@aoo/catalog";
import { createProviderFromConfig, loadRoleAccessAgentConfig } from "../config.js";
import { ROLE_ACCESS_EVAL_CASES, ROLE_ACCESS_EVAL_CATALOG_VERSION } from "../eval/dataset.js";
import { scoreRoleAccessEval, type RoleAccessEvalObservation } from "../eval/metrics.js";
import type { ModelProvider } from "../providers/types.js";
import { RoleAccessAgentError, createRoleAccessAgent } from "../role-access/agent.js";
import { ROLE_ACCESS_PROMPT_VERSION } from "../role-access/prompt.js";

// The repo-root .env (git-ignored) holds the credentials; it is never printed.
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadRoleAccessAgentConfig();
} catch (err) {
  console.error(`BLOCKED: live evaluation needs model credentials (${(err as Error).message}).`);
  process.exit(2);
}

const catalog = loadCatalogRegistry().get(ROLE_ACCESS_EVAL_CATALOG_VERSION);
const real = createProviderFromConfig(config);
// Spy: keeps the last raw structured output so invalid answers can be scored too.
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
const agent = createRoleAccessAgent({
  provider,
  maxAttempts: config.ROLE_ACCESS_AGENT_MAX_ATTEMPTS,
});

const observations: RoleAccessEvalObservation[] = [];
for (const evalCase of ROLE_ACCESS_EVAL_CASES) {
  lastRaw = undefined;
  lastUsage = undefined;
  const started = performance.now();
  let outcome = "ok";
  try {
    await agent.recommend({
      workflowId: `eval-${evalCase.id}`,
      employeeId: `EVAL-${evalCase.id}`,
      context: evalCase.context,
      catalog,
    });
  } catch (err) {
    outcome = err instanceof RoleAccessAgentError ? err.category : "INTERNAL";
  }
  observations.push({
    case: evalCase,
    rawOutput: lastRaw,
    outcome,
    latencyMs: Math.round(performance.now() - started),
    usage: lastUsage,
  });
  console.error(`case ${evalCase.id}: ${outcome}`);
}

const report = scoreRoleAccessEval(observations, catalog);
console.log(
  JSON.stringify(
    {
      provider: real.provider,
      model: real.model,
      modelConfig: real.configId,
      servedModels: [...servedModels].sort(),
      promptVersion: ROLE_ACCESS_PROMPT_VERSION,
      catalogVersion: catalog.catalogVersion,
      catalogHash: catalog.catalogHash,
      ...report,
    },
    null,
    2,
  ),
);
