const REDACTED = "[REDACTED]";

/**
 * Removes credentials from free text: Okta SSWS tokens, bearer/basic credentials, URL userinfo,
 * URL query strings (Okta searches carry employee identifiers) and secret-like key=value pairs.
 */
export function redactOktaText(text: string, sensitiveValues: readonly string[] = []): string {
  let out = text
    .replace(/\b(SSWS|Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`)
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, `$1?${REDACTED}`)
    .replace(
      /\b([A-Za-z_]*(?:authorization|password|secret|token|api[-_]?key)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|[^\s&,;]+)/gi,
      `$1=${REDACTED}`,
    );
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (value && value.length >= 6) out = out.split(value).join(REDACTED);
  }
  return out;
}
