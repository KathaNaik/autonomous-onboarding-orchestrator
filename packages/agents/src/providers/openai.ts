import { sanitizeProviderText } from "./sanitize.js";
import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "./types.js";

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  /** https origin, e.g. https://api.openai.com. */
  baseUrl: string;
  timeoutMs: number;
  /** max_output_tokens (includes any reasoning tokens the model spends). */
  maxOutputTokens: number;
}

const MAX_RETRY_AFTER_MS = 10_000;

function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms)) {
    return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
  }
  const seconds = Number(headers.get("retry-after"));
  if (headers.get("retry-after") !== null && Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

interface ResponsesApiBody {
  id?: string;
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string } | null;
  output?: {
    type?: string;
    content?: { type?: string; text?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * OpenAI Responses API over fetch, with Structured Outputs: `text.format` is a strict JSON
 * schema, so the model can only return a conforming JSON object. No tools or functions are sent,
 * and responses are not stored (`store: false`). Errors carry a category, HTTP status and the
 * provider's error code only: never the API key, request headers or response text.
 */
export function createOpenAIProvider(
  config: OpenAIProviderConfig,
  deps: { fetch?: typeof fetch } = {},
): ModelProvider {
  const doFetch = deps.fetch ?? fetch;
  const configId = `openai-responses/${config.model}/structured=strict/max_output_tokens=${config.maxOutputTokens}`;
  const scrub = (text: string) => sanitizeProviderText(text, [config.apiKey]);

  return {
    provider: "openai",
    model: config.model,
    configId,
    async generate(request: ModelRequest, { signal }): Promise<ModelResponse> {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
      let res: Response;
      try {
        res = await doFetch(`${config.baseUrl}/v1/responses`, {
          method: "POST",
          redirect: "error",
          signal: attemptSignal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            instructions: request.system,
            // (M11) With attached files the user turn carries them as input_file parts; a
            // text-only request is unchanged.
            input: request.files?.length
              ? [
                  {
                    role: "user",
                    content: [
                      ...request.files.map((f) => ({
                        type: "input_file",
                        filename: f.filename,
                        file_data: `data:${f.mimeType};base64,${f.dataBase64}`,
                      })),
                      { type: "input_text", text: request.user },
                    ],
                  },
                ]
              : request.user,
            text: {
              format: {
                type: "json_schema",
                name: request.structuredOutput.name,
                schema: request.structuredOutput.schema,
                strict: true,
              },
            },
            max_output_tokens: config.maxOutputTokens,
            store: false,
          }),
        });
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ModelProviderError("TIMEOUT", "model request timed out or was aborted");
        }
        throw new ModelProviderError(
          "NETWORK",
          scrub(`network error: ${(err as Error).message ?? "unknown"}`),
        );
      }

      if (!res.ok) {
        // Only the provider's error code/type is kept, never the message text.
        let code = "";
        try {
          const error = ((await res.json()) as { error?: { code?: unknown; type?: unknown } })
            .error;
          code = String(error?.code ?? error?.type ?? "");
        } catch {
          // ignore unreadable bodies
        }
        const status = res.status;
        const detail = `HTTP ${status}${code ? ` (${scrub(code).slice(0, 60)})` : ""}`;
        if (status === 429 && code === "insufficient_quota") {
          // Billing/quota exhaustion: retrying cannot help.
          throw new ModelProviderError("BAD_REQUEST", `quota exhausted: ${detail}`, {
            httpStatus: status,
          });
        }
        if (status === 429) {
          const wait = retryAfterMs(res.headers);
          throw new ModelProviderError("RATE_LIMITED", `rate limited: ${detail}`, {
            httpStatus: status,
            ...(wait !== undefined && { retryAfterMs: wait }),
          });
        }
        if (status === 408) {
          throw new ModelProviderError("TIMEOUT", `provider timed out: ${detail}`, {
            httpStatus: status,
          });
        }
        if (status >= 500) {
          throw new ModelProviderError("PROVIDER_UNAVAILABLE", `provider error: ${detail}`, {
            httpStatus: status,
          });
        }
        if (status === 401 || status === 403) {
          throw new ModelProviderError("AUTHENTICATION", `authentication failed: ${detail}`, {
            httpStatus: status,
          });
        }
        throw new ModelProviderError("BAD_REQUEST", `request rejected: ${detail}`, {
          httpStatus: status,
        });
      }

      let body: ResponsesApiBody;
      try {
        body = (await res.json()) as ResponsesApiBody;
      } catch {
        throw new ModelProviderError("MALFORMED_OUTPUT", "response body is not JSON");
      }
      if (body.status === "failed") {
        throw new ModelProviderError(
          "PROVIDER_UNAVAILABLE",
          `response failed${body.error?.code ? ` (${scrub(String(body.error.code)).slice(0, 60)})` : ""}`,
        );
      }
      if (body.status === "incomplete") {
        const reason = body.incomplete_details?.reason ?? "unknown";
        throw new ModelProviderError(
          "MALFORMED_OUTPUT",
          `response incomplete (${scrub(String(reason)).slice(0, 60)})`,
        );
      }
      const content = (body.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? []);
      if (content.some((part) => part.type === "refusal")) {
        throw new ModelProviderError("MALFORMED_OUTPUT", "model refused to produce the output");
      }
      const text = content.find((part) => part.type === "output_text")?.text;
      if (typeof text !== "string") {
        throw new ModelProviderError("MALFORMED_OUTPUT", "response has no structured output");
      }
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ModelProviderError("MALFORMED_OUTPUT", "structured output is not valid JSON");
      }
      const usage = body.usage;
      return {
        output,
        ...(typeof usage?.input_tokens === "number" &&
          typeof usage.output_tokens === "number" && {
            usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
          }),
        ...(typeof body.model === "string" && { model: body.model }),
        ...(typeof body.id === "string" && { responseId: body.id.slice(0, 200) }),
      };
    },
  };
}
