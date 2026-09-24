import { createHash } from "node:crypto";
import { canonicalJson, type ResourceCatalog } from "@aoo/catalog";
import { sanitizeProviderText } from "../providers/sanitize.js";
import {
  ModelProviderError,
  TRANSIENT_MODEL_ERRORS,
  type ModelErrorCategory,
  type ModelProvider,
  type ModelUsage,
} from "../providers/types.js";
import {
  ROLE_ACCESS_PROMPT_VERSION,
  ROLE_ACCESS_SYSTEM_PROMPT,
  buildUserMessage,
} from "./prompt.js";
import {
  ROLE_ACCESS_OUTPUT_JSON_SCHEMA,
  ROLE_ACCESS_OUTPUT_SCHEMA_NAME,
  RecommendationContextSchema,
  RoleAccessModelOutputSchema,
  type AvailableResource,
  type RecommendationContext,
  type RecommendationDependency,
  type RoleAccessModelInput,
  type ValidatedRecommendation,
} from "./schema.js";

export type RoleAccessErrorCategory =
  | ModelErrorCategory
  /** Schema-valid output naming unknown, disabled or repeated resources. Never retried. */
  | "INVALID_RECOMMENDATION"
  /** The deterministic input is malformed. Never retried. */
  | "INVALID_INPUT";

export interface InvalidRecommendationDetails {
  readonly unknownResourceIds: readonly string[];
  readonly disabledResourceIds: readonly string[];
  readonly duplicateResourceIds: readonly string[];
}

/** Agent failure. `message` is sanitized; `retryable` says whether a later run may succeed. */
export class RoleAccessAgentError extends Error {
  readonly category: RoleAccessErrorCategory;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly httpStatus: number | undefined;
  readonly details: InvalidRecommendationDetails | undefined;
  readonly usage: ModelUsage | undefined;

  constructor(
    category: RoleAccessErrorCategory,
    message: string,
    options: {
      attempts?: number;
      httpStatus?: number | undefined;
      details?: InvalidRecommendationDetails;
      usage?: ModelUsage | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.category = category;
    this.retryable = (TRANSIENT_MODEL_ERRORS as readonly string[]).includes(category);
    this.attempts = options.attempts ?? 0;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
    this.usage = options.usage;
  }
}

export interface RoleAccessAgentInput {
  /** Identifiers for traceability only; never sent to the model. */
  readonly workflowId: string;
  readonly employeeId: string;
  readonly context: RecommendationContext;
  /** The exact released catalog version the run is bound to. */
  readonly catalog: ResourceCatalog;
}

export interface RoleAccessAgentResult {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly modelConfig: string;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly inputHash: string;
  /** Validated, sorted by resource id. May be empty. */
  readonly recommendations: readonly ValidatedRecommendation[];
  /** Catalog dependencies of the recommended resources; not recommendations themselves. */
  readonly dependencies: readonly RecommendationDependency[];
  readonly attempts: number;
  readonly latencyMs: number;
  readonly usage: ModelUsage | undefined;
  /** Model the provider reports having served the successful call, if it reports one. */
  readonly servedModel: string | undefined;
}

export interface RoleAccessAgent {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly modelConfig: string;
  /** Pure: the model-visible input and its hash (no model call). */
  prepare(input: RoleAccessAgentInput): { modelInput: RoleAccessModelInput; inputHash: string };
  recommend(
    input: RoleAccessAgentInput,
    options?: { signal?: AbortSignal },
  ): Promise<RoleAccessAgentResult>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The enabled resources, recommendation fields only (no provider metadata, no risk data). */
export function availableResources(catalog: ResourceCatalog): readonly AvailableResource[] {
  return Object.freeze(
    catalog.snapshot().resources.map((r) =>
      Object.freeze({
        resourceId: r.resourceId,
        displayName: r.displayName,
        description: r.description,
        category: r.category,
        environment: r.environment,
      }),
    ),
  );
}

/**
 * Post-model validation against the exact catalog. Any unknown, disabled or repeated id fails
 * the whole output: nothing is silently dropped.
 */
export function validateRecommendations(
  output: unknown,
  catalog: ResourceCatalog,
): readonly ValidatedRecommendation[] {
  const parsed = RoleAccessModelOutputSchema.safeParse(output);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new RoleAccessAgentError(
      "MALFORMED_OUTPUT",
      `model output does not match the contract at: ${fields.slice(0, 10).join(", ")}`,
    );
  }
  const ids = parsed.data.recommendations.map((r) => r.resourceId);
  const check = catalog.validateResourceIds(ids);
  if (!check.valid) {
    const details: InvalidRecommendationDetails = {
      unknownResourceIds: check.unknown,
      disabledResourceIds: check.disabled,
      duplicateResourceIds: check.duplicates,
    };
    const parts = [
      check.unknown.length && `${check.unknown.length} unknown`,
      check.disabled.length && `${check.disabled.length} disabled`,
      check.duplicates.length && `${check.duplicates.length} duplicate`,
    ].filter(Boolean);
    throw new RoleAccessAgentError(
      "INVALID_RECOMMENDATION",
      `model recommended ${parts.join(", ")} resource id(s) for catalog ${catalog.catalogVersion}`,
      { details },
    );
  }
  return Object.freeze(
    [...parsed.data.recommendations]
      .sort((a, b) => compare(a.resourceId, b.resourceId))
      .map((r) => Object.freeze({ ...r })),
  );
}

export interface RoleAccessAgentOptions {
  provider: ModelProvider;
  /** Total model calls per run, including the first (transient failures only). */
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
 * The Role Access Agent: a plain service (input → provider → structured output → validation).
 * It recommends only. It holds no database, policy, adapter or network capability of its own.
 */
export function createRoleAccessAgent(options: RoleAccessAgentOptions): RoleAccessAgent {
  const { provider } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const base = options.backoffBaseMs ?? 500;
  const cap = options.backoffMaxMs ?? 8000;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());

  function prepare(input: RoleAccessAgentInput) {
    const context = RecommendationContextSchema.safeParse(input.context);
    if (!context.success) {
      throw new RoleAccessAgentError(
        "INVALID_INPUT",
        `invalid recommendation context: ${context.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
    }
    const modelInput: RoleAccessModelInput = Object.freeze({
      catalogVersion: input.catalog.catalogVersion,
      catalogHash: input.catalog.catalogHash,
      employeeContext: Object.freeze(context.data),
      availableResources: availableResources(input.catalog),
    });
    const inputHash = `sha256:${createHash("sha256").update(canonicalJson(modelInput)).digest("hex")}`;
    return { modelInput, inputHash };
  }

  return {
    promptVersion: ROLE_ACCESS_PROMPT_VERSION,
    provider: provider.provider,
    model: provider.model,
    modelConfig: provider.configId,
    prepare,
    async recommend(input, { signal = new AbortController().signal } = {}) {
      const { modelInput, inputHash } = prepare(input);
      const request = {
        system: ROLE_ACCESS_SYSTEM_PROMPT,
        user: buildUserMessage(modelInput),
        structuredOutput: {
          name: ROLE_ACCESS_OUTPUT_SCHEMA_NAME,
          schema: ROLE_ACCESS_OUTPUT_JSON_SCHEMA as Record<string, unknown>,
        },
      } as const;

      const started = now();
      let usage: ModelUsage | undefined;
      for (let attempt = 1; ; attempt++) {
        let failure: RoleAccessAgentError;
        try {
          const response = await provider.generate(request, { signal });
          if (response.usage) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + response.usage.inputTokens,
              outputTokens: (usage?.outputTokens ?? 0) + response.usage.outputTokens,
            };
          }
          const recommendations = validateRecommendations(response.output, input.catalog);
          return Object.freeze({
            promptVersion: ROLE_ACCESS_PROMPT_VERSION,
            provider: provider.provider,
            model: provider.model,
            modelConfig: provider.configId,
            catalogVersion: input.catalog.catalogVersion,
            catalogHash: input.catalog.catalogHash,
            inputHash,
            recommendations,
            dependencies: Object.freeze(
              recommendations
                .map((r) => ({
                  resourceId: r.resourceId,
                  dependsOn: input.catalog.getResource(r.resourceId).dependsOn,
                }))
                .filter((d) => d.dependsOn.length > 0),
            ),
            attempts: attempt,
            latencyMs: Math.round(now() - started),
            usage,
            servedModel: response.model,
          });
        } catch (err) {
          if (err instanceof RoleAccessAgentError) {
            failure = new RoleAccessAgentError(err.category, err.message, {
              attempts: attempt,
              ...(err.details && { details: err.details }),
              usage,
            });
          } else if (err instanceof ModelProviderError) {
            failure = new RoleAccessAgentError(err.category, sanitizeProviderText(err.message), {
              attempts: attempt,
              httpStatus: err.httpStatus,
              usage,
            });
          } else {
            // Unknown provider behavior: treat as a network-level fault, message scrubbed.
            failure = new RoleAccessAgentError(
              "NETWORK",
              sanitizeProviderText(`unexpected provider error: ${(err as Error)?.message ?? err}`),
              { attempts: attempt, usage },
            );
          }
          const retryAfter = err instanceof ModelProviderError ? err.retryAfterMs : undefined;
          if (!failure.retryable || attempt >= maxAttempts || signal.aborted) throw failure;
          const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
          const delay = Math.max(retryAfter ?? 0, ceiling / 2 + random() * (ceiling / 2));
          await sleep(delay, signal);
          if (signal.aborted) throw failure;
        }
      }
    },
  };
}
