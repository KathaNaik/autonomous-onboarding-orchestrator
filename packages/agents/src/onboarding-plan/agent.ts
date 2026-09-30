import { createHash } from "node:crypto";
import { canonicalJson } from "@aoo/catalog";
import { sanitizeProviderText } from "../providers/sanitize.js";
import {
  ModelProviderError,
  type ModelErrorCategory,
  type ModelProvider,
  type ModelUsage,
} from "../providers/types.js";
import {
  ONBOARDING_PLAN_PROMPT_VERSION,
  ONBOARDING_PLAN_SYSTEM_PROMPT,
  buildOnboardingPlanUserMessage,
} from "./prompt.js";
import {
  ONBOARDING_PLAN_OUTPUT_JSON_SCHEMA,
  ONBOARDING_PLAN_OUTPUT_SCHEMA_NAME,
  OnboardingPlanModelInputSchema,
  type OnboardingPlanModelInput,
  type ValidatedOnboardingPlan,
} from "./schema.js";
import { validateOnboardingPlan, type PlanViolation } from "./validate.js";

export type OnboardingPlanErrorCategory =
  | ModelErrorCategory
  /** Schema-valid output that references unknown/unavailable resources or forbidden content. */
  | "INVALID_PLAN"
  /** The deterministic input is malformed. Never retried. */
  | "INVALID_INPUT";

/**
 * Transport failures only: a later run may succeed. Output-contract failures (MALFORMED_OUTPUT,
 * INVALID_PLAN) are retried within one run up to maxAttempts, then are final for the run, so a
 * model that keeps producing invalid plans can never loop forever.
 */
export const RETRYABLE_PLAN_ERRORS: readonly OnboardingPlanErrorCategory[] = Object.freeze([
  "TIMEOUT",
  "NETWORK",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
]);
const RETRY_WITHIN_RUN: readonly OnboardingPlanErrorCategory[] = Object.freeze([
  ...RETRYABLE_PLAN_ERRORS,
  "MALFORMED_OUTPUT",
  "INVALID_PLAN",
]);

/** Agent failure. `message` is sanitized; `retryable` says whether a later run may succeed. */
export class OnboardingPlanAgentError extends Error {
  readonly category: OnboardingPlanErrorCategory;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly httpStatus: number | undefined;
  /** INVALID_PLAN: violation codes (and input resource ids), never model text. */
  readonly violations: readonly PlanViolation[] | undefined;
  /** MALFORMED_OUTPUT: contract paths that failed. */
  readonly fields: readonly string[] | undefined;
  readonly usage: ModelUsage | undefined;

  constructor(
    category: OnboardingPlanErrorCategory,
    message: string,
    options: {
      attempts?: number;
      httpStatus?: number | undefined;
      violations?: readonly PlanViolation[] | undefined;
      fields?: readonly string[] | undefined;
      usage?: ModelUsage | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.category = category;
    this.retryable = RETRYABLE_PLAN_ERRORS.includes(category);
    this.attempts = options.attempts ?? 0;
    this.httpStatus = options.httpStatus;
    this.violations = options.violations;
    this.fields = options.fields;
    this.usage = options.usage;
  }
}

export interface OnboardingPlanAgentInput {
  /** The model-facing input (sent and persisted as the snapshot). */
  readonly modelInput: OnboardingPlanModelInput;
  /** Validation only; never sent to the model. */
  readonly catalogResourceIds?: readonly string[];
  /** Validation only; never sent to the model. */
  readonly forbiddenTerms?: readonly string[];
}

export interface OnboardingPlanAgentResult {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly modelConfig: string;
  readonly inputHash: string;
  readonly plan: ValidatedOnboardingPlan;
  /** Model calls in this run, including retries. */
  readonly attempts: number;
  readonly latencyMs: number;
  readonly usage: ModelUsage | undefined;
  readonly servedModel: string | undefined;
  readonly responseId: string | undefined;
}

export interface OnboardingPlanAgent {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly modelConfig: string;
  /** Pure: validates the model-facing input and hashes it (no model call). */
  prepare(input: OnboardingPlanAgentInput): {
    modelInput: OnboardingPlanModelInput;
    inputHash: string;
  };
  generate(
    input: OnboardingPlanAgentInput,
    options?: { signal?: AbortSignal },
  ): Promise<OnboardingPlanAgentResult>;
}

export interface OnboardingPlanAgentOptions {
  provider: ModelProvider;
  /** Total model calls per run, including the first. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * The Onboarding Plan Agent (M8), the second and final agent: input → provider → structured output
 * → post-model validation. It proposes a checklist only. It holds no database, policy, adapter or
 * network capability of its own and never authorizes or provisions anything.
 */
export function createOnboardingPlanAgent(
  options: OnboardingPlanAgentOptions,
): OnboardingPlanAgent {
  const { provider } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const base = options.backoffBaseMs ?? 500;
  const cap = options.backoffMaxMs ?? 8000;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());

  function prepare(input: OnboardingPlanAgentInput) {
    const parsed = OnboardingPlanModelInputSchema.safeParse(input.modelInput);
    if (!parsed.success) {
      throw new OnboardingPlanAgentError(
        "INVALID_INPUT",
        `invalid onboarding plan input: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".")))].slice(0, 10).join(", ")}`,
      );
    }
    const ids = parsed.data.resources.map((r) => r.resourceId);
    if (new Set(ids).size !== ids.length) {
      throw new OnboardingPlanAgentError("INVALID_INPUT", "duplicate resource in plan input");
    }
    const modelInput = Object.freeze(parsed.data);
    const inputHash = `sha256:${createHash("sha256").update(canonicalJson(modelInput)).digest("hex")}`;
    return { modelInput, inputHash };
  }

  return {
    promptVersion: ONBOARDING_PLAN_PROMPT_VERSION,
    provider: provider.provider,
    model: provider.model,
    modelConfig: provider.configId,
    prepare,
    async generate(input, { signal = new AbortController().signal } = {}) {
      const { modelInput, inputHash } = prepare(input);
      const request = {
        system: ONBOARDING_PLAN_SYSTEM_PROMPT,
        user: buildOnboardingPlanUserMessage(modelInput),
        structuredOutput: {
          name: ONBOARDING_PLAN_OUTPUT_SCHEMA_NAME,
          schema: ONBOARDING_PLAN_OUTPUT_JSON_SCHEMA as Record<string, unknown>,
        },
      } as const;

      const started = now();
      let usage: ModelUsage | undefined;
      for (let attempt = 1; ; attempt++) {
        let failure: OnboardingPlanAgentError;
        let retryAfter: number | undefined;
        try {
          const response = await provider.generate(request, { signal });
          if (response.usage) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + response.usage.inputTokens,
              outputTokens: (usage?.outputTokens ?? 0) + response.usage.outputTokens,
            };
          }
          const checked = validateOnboardingPlan(response.output, {
            input: modelInput,
            ...(input.catalogResourceIds && { catalogResourceIds: input.catalogResourceIds }),
            ...(input.forbiddenTerms && { forbiddenTerms: input.forbiddenTerms }),
          });
          if (checked.ok) {
            return Object.freeze({
              promptVersion: ONBOARDING_PLAN_PROMPT_VERSION,
              provider: provider.provider,
              model: provider.model,
              modelConfig: provider.configId,
              inputHash,
              plan: checked.plan,
              attempts: attempt,
              latencyMs: Math.round(now() - started),
              usage,
              servedModel: response.model,
              responseId: response.responseId,
            });
          }
          failure =
            checked.kind === "MALFORMED"
              ? new OnboardingPlanAgentError(
                  "MALFORMED_OUTPUT",
                  `model output does not match the contract at: ${checked.fields.join(", ")}`,
                  { attempts: attempt, fields: checked.fields, usage },
                )
              : new OnboardingPlanAgentError(
                  "INVALID_PLAN",
                  `model plan rejected: ${checked.violations.map((v) => v.code).join(", ")}`,
                  { attempts: attempt, violations: checked.violations, usage },
                );
        } catch (err) {
          if (err instanceof ModelProviderError) {
            failure = new OnboardingPlanAgentError(
              err.category,
              sanitizeProviderText(err.message),
              { attempts: attempt, httpStatus: err.httpStatus, usage },
            );
            retryAfter = err.retryAfterMs;
          } else {
            failure = new OnboardingPlanAgentError(
              "NETWORK",
              sanitizeProviderText(`unexpected provider error: ${(err as Error)?.message ?? err}`),
              { attempts: attempt, usage },
            );
          }
        }
        if (!RETRY_WITHIN_RUN.includes(failure.category) || attempt >= maxAttempts) throw failure;
        if (signal.aborted) throw failure;
        const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
        await sleep(Math.max(retryAfter ?? 0, ceiling / 2 + random() * (ceiling / 2)), signal);
        if (signal.aborted) throw failure;
      }
    },
  };
}
