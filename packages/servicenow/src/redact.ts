const SENSITIVE_KEY =
  /authorization|password|passwd|secret|token|cookie|session|api[-_]?key|credential/i;
const REDACTED = "[REDACTED]";

/**
 * Removes credentials from free text: auth schemes, basic-auth userinfo in URLs and
 * key=value pairs with sensitive names. Applied to every adapter error message and log line.
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`)
    .replace(
      /\b([A-Za-z_]*(?:password|secret|token|api[-_]?key)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|[^\s&,;]+)/gi,
      `$1=${REDACTED}`,
    );
}

/** Deep-copies a value for logging with sensitive keys and credential-looking text masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

/** Instance origin + path only: no userinfo, no query string (queries can contain employee data). */
export function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
