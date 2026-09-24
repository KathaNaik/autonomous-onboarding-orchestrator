const MAX_MESSAGE = 300;

/**
 * Scrubs free text before it is persisted or logged: API keys, Authorization / x-api-key headers,
 * bearer and basic tokens, URL userinfo and query strings, and secret-like key=value pairs.
 */
export function sanitizeProviderText(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let out = text
    // Provider API keys (OpenAI "sk-…"/"sk-proj-…", and other sk- prefixed keys).
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(
      /\b(authorization|x-api-key|api[-_]?key|proxy-authorization)\s*[:=]\s*[^\s,;]+(\s+[^\s,;]+)?/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(/\b(secret|password|token|key)=\S+/gi, "$1=[REDACTED]");
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (value && value.length >= 6) out = out.split(value).join("[REDACTED]");
  }
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}
