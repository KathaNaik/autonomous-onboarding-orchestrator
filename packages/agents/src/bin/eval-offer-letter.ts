// Explicit live evaluation of the Offer Letter Extractor (M11) against the real model provider.
// Run from the repo root: pnpm test:offer-letter:eval   (needs OPENAI_API_KEY in .env)
// Never part of pnpm check or pnpm test:integration. Without credentials it reports BLOCKED and
// exits non-zero; it never substitutes a test double. Synthetic, fictional letters only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOfferLetterProviderFromConfig, loadOfferLetterAgentConfig } from "../config.js";
import { OFFER_LETTER_EVAL_CASES } from "../eval/offer-letter-dataset.js";
import {
  scoreOfferLetterEval,
  type OfferLetterEvalObservation,
} from "../eval/offer-letter-metrics.js";
import { OfferLetterAgentError, createOfferLetterAgent } from "../offer-letter/agent.js";
import { OFFER_LETTER_PROMPT_VERSION } from "../offer-letter/prompt.js";
import type { ModelProvider } from "../providers/types.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadOfferLetterAgentConfig();
} catch (err) {
  console.error(`BLOCKED: live evaluation needs model credentials (${(err as Error).message}).`);
  process.exit(2);
}
const real = createOfferLetterProviderFromConfig(config);
const servedModels = new Set<string>();
let tokens = { input: 0, output: 0 };
const provider: ModelProvider = {
  provider: real.provider,
  model: real.model,
  configId: real.configId,
  async generate(request, options) {
    const response = await real.generate(request, options);
    if (response.model) servedModels.add(response.model);
    tokens = {
      input: tokens.input + (response.usage?.inputTokens ?? 0),
      output: tokens.output + (response.usage?.outputTokens ?? 0),
    };
    return response;
  },
};
// One model call per case: the answer is scored as produced (no retry can mask it).
const agent = createOfferLetterAgent({ provider, maxAttempts: 1 });
const observations: OfferLetterEvalObservation[] = [];
for (const c of OFFER_LETTER_EVAL_CASES) {
  const started = performance.now();
  try {
    const result = await agent.extract({ pdf: c.pdf });
    observations.push({
      caseId: c.id,
      proposal: result.proposal,
      error: null,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    observations.push({
      caseId: c.id,
      proposal: null,
      error: err instanceof OfferLetterAgentError ? err.category : "UNEXPECTED",
      latencyMs: Math.round(performance.now() - started),
    });
  }
}
const score = scoreOfferLetterEval(OFFER_LETTER_EVAL_CASES, observations);
console.log(
  JSON.stringify(
    {
      provider: real.provider,
      model: real.model,
      modelConfig: real.configId,
      servedModels: [...servedModels],
      promptVersion: OFFER_LETTER_PROMPT_VERSION,
      tokens,
      ...score,
    },
    null,
    2,
  ),
);
process.exitCode = score.schemaValidRate === 1 && score.forbiddenLeaks === 0 ? 0 : 1;
