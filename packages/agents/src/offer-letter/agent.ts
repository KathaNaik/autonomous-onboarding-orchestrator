import { createHash } from "node:crypto";
import { sanitizeProviderText } from "../providers/sanitize.js";
import {
  ModelProviderError,
  type ModelErrorCategory,
  type ModelProvider,
  type ModelUsage,
} from "../providers/types.js";
import {
  OFFER_LETTER_PROMPT_VERSION,
  OFFER_LETTER_SYSTEM_PROMPT,
  buildOfferLetterUserMessage,
} from "./prompt.js";
import {
  OFFER_LETTER_OUTPUT_JSON_SCHEMA,
  OFFER_LETTER_OUTPUT_SCHEMA_NAME,
  type OfferLetterProposal,
} from "./schema.js";
import { validateOfferLetterOutput } from "./validate.js";

/** Largest offer letter accepted (Vercel Functions cap request bodies at 4.5 MB). */
export const OFFER_LETTER_MAX_BYTES = 4 * 1024 * 1024;

export type OfferLetterErrorCategory = ModelErrorCategory | "INVALID_DOCUMENT";

/** Agent failure; `message` is sanitized and never contains document text. */
export class OfferLetterAgentError extends Error {
  readonly category: OfferLetterErrorCategory;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly httpStatus: number | undefined;
  readonly usage: ModelUsage | undefined;

  constructor(
    category: OfferLetterErrorCategory,
    message: string,
    options: { attempts?: number; httpStatus?: number | undefined; usage?: ModelUsage } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.category = category;
    this.retryable = ["TIMEOUT", "NETWORK", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(
      category,
    );
    this.attempts = options.attempts ?? 0;
    this.httpStatus = options.httpStatus;
    this.usage = options.usage;
  }
}

export interface OfferLetterAgentResult {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly modelConfig: string;
  /** sha256 of the exact PDF bytes (the file itself is never kept). */
  readonly fileSha256: string;
  readonly fileBytes: number;
  readonly proposal: OfferLetterProposal;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly usage: ModelUsage | undefined;
  readonly servedModel: string | undefined;
  readonly responseId: string | undefined;
}

export interface OfferLetterAgent {
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  extract(
    input: { pdf: Uint8Array },
    options?: { signal?: AbortSignal },
  ): Promise<OfferLetterAgentResult>;
}

/** Checks the bytes are a plausible PDF of acceptable size before any model call. */
export function assertOfferLetterPdf(pdf: Uint8Array): void {
  if (pdf.byteLength === 0) throw new OfferLetterAgentError("INVALID_DOCUMENT", "empty file");
  if (pdf.byteLength > OFFER_LETTER_MAX_BYTES) {
    throw new OfferLetterAgentError("INVALID_DOCUMENT", "file larger than 4 MB");
  }
  if (!looksLikePdf(pdf))
    throw new OfferLetterAgentError("INVALID_DOCUMENT", "not a valid PDF file");
}

/**
 * Structural check before any model call: a `%PDF-<major>.<minor>` header and an `%%EOF` marker in
 * the last 1 KiB (truncated or headerless files are rejected without reaching the provider).
 */
export function looksLikePdf(pdf: Uint8Array): boolean {
  const head = Buffer.from(pdf.subarray(0, 8)).toString("latin1");
  const tail = Buffer.from(pdf.subarray(Math.max(0, pdf.byteLength - 1024))).toString("latin1");
  return /^%PDF-\d\.\d/.test(head) && tail.includes("%%EOF");
}

/**
 * (M11) The Offer Letter Extractor, a bounded extraction component (not an agent): one PDF → proposed display fields for the
 * operator's review. It extracts only: no authorization facts, no decisions, no tools, no
 * database or network capability of its own. Its output is a proposal an operator must confirm.
 */
export function createOfferLetterAgent(options: {
  provider: ModelProvider;
  /** Total model calls, including the first (malformed output and transient errors retry). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): OfferLetterAgent {
  const { provider } = options;
  const maxAttempts = options.maxAttempts ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => performance.now());
  const RETRY: readonly OfferLetterErrorCategory[] = [
    "TIMEOUT",
    "NETWORK",
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "MALFORMED_OUTPUT",
  ];

  return {
    promptVersion: OFFER_LETTER_PROMPT_VERSION,
    provider: provider.provider,
    model: provider.model,
    async extract({ pdf }, { signal = new AbortController().signal } = {}) {
      assertOfferLetterPdf(pdf);
      const fileSha256 = `sha256:${createHash("sha256").update(pdf).digest("hex")}`;
      const request = {
        system: OFFER_LETTER_SYSTEM_PROMPT,
        user: buildOfferLetterUserMessage(),
        // A fixed name: the operator's file name is untrusted and never reaches the model.
        files: [
          {
            filename: "offer-letter.pdf",
            mimeType: "application/pdf" as const,
            dataBase64: Buffer.from(pdf).toString("base64"),
          },
        ],
        structuredOutput: {
          name: OFFER_LETTER_OUTPUT_SCHEMA_NAME,
          schema: OFFER_LETTER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      };
      const started = now();
      let usage: ModelUsage | undefined;
      for (let attempt = 1; ; attempt++) {
        let failure: OfferLetterAgentError;
        try {
          const response = await provider.generate(request, { signal });
          if (response.usage) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + response.usage.inputTokens,
              outputTokens: (usage?.outputTokens ?? 0) + response.usage.outputTokens,
            };
          }
          const checked = validateOfferLetterOutput(response.output);
          if (checked.ok) {
            return Object.freeze({
              promptVersion: OFFER_LETTER_PROMPT_VERSION,
              provider: provider.provider,
              model: provider.model,
              modelConfig: provider.configId,
              fileSha256,
              fileBytes: pdf.byteLength,
              proposal: checked.proposal,
              attempts: attempt,
              latencyMs: Math.round(now() - started),
              usage,
              servedModel: response.model,
              responseId: response.responseId,
            });
          }
          failure = new OfferLetterAgentError(
            "MALFORMED_OUTPUT",
            `model output does not match the contract at: ${checked.fields.join(", ")}`,
            { attempts: attempt, ...(usage && { usage }) },
          );
        } catch (err) {
          failure =
            err instanceof ModelProviderError
              ? new OfferLetterAgentError(err.category, sanitizeProviderText(err.message), {
                  attempts: attempt,
                  httpStatus: err.httpStatus,
                  ...(usage && { usage }),
                })
              : new OfferLetterAgentError("NETWORK", "unexpected provider error", {
                  attempts: attempt,
                  ...(usage && { usage }),
                });
        }
        if (!RETRY.includes(failure.category) || attempt >= maxAttempts || signal.aborted) {
          throw failure;
        }
        await sleep(500 * attempt);
      }
    },
  };
}
