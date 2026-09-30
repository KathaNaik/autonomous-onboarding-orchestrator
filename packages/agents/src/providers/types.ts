/**
 * Minimal, explicit model-provider abstraction. A provider turns one request into one structured
 * JSON object that must conform to a strict schema. It has no other capability: no tools or
 * functions, no network access on the agent's behalf, no state.
 */
export interface ModelRequest {
  readonly system: string;
  readonly user: string;
  /** The response must be a JSON object matching this strict schema. Data only, no actions. */
  readonly structuredOutput: {
    readonly name: string;
    /** Strict JSON Schema of the output object. */
    readonly schema: Record<string, unknown>;
  };
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  /** The raw structured output; always validated by the caller before use. */
  readonly output: unknown;
  readonly usage?: ModelUsage;
  /** The model identifier the provider reports having served, when it reports one. */
  readonly model?: string;
  /** The provider's response id, when it reports one (audit/provenance only). */
  readonly responseId?: string;
}

export interface ModelProvider {
  /** e.g. "openai". */
  readonly provider: string;
  readonly model: string;
  /**
   * Deterministic identity of everything that shapes model behavior besides the prompt
   * (provider, model, sampling, token limit). Part of the logical run key.
   */
  readonly configId: string;
  generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse>;
}

export type ModelErrorCategory =
  | "TIMEOUT"
  | "NETWORK"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED_OUTPUT"
  | "AUTHENTICATION"
  | "BAD_REQUEST";

/** Categories worth retrying: the same request may succeed later. */
export const TRANSIENT_MODEL_ERRORS: readonly ModelErrorCategory[] = Object.freeze([
  "TIMEOUT",
  "NETWORK",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "MALFORMED_OUTPUT",
]);

/** Provider failure. The message must already be sanitized (no keys, headers or bodies). */
export class ModelProviderError extends Error {
  readonly category: ModelErrorCategory;
  readonly httpStatus: number | undefined;
  /** Provider-suggested wait before retrying (Retry-After), if any. */
  readonly retryAfterMs: number | undefined;

  constructor(
    category: ModelErrorCategory,
    message: string,
    options: { httpStatus?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.category = category;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}
