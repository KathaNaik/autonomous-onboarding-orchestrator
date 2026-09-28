const REDACTED = "[REDACTED]";

/**
 * Removes credentials from free text: GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_),
 * bearer/basic/token authorization values, URL userinfo, URL query strings and secret-like
 * key=value pairs, plus any given values.
 */
export function redactGitHubText(text: string, sensitiveValues: readonly string[] = []): string {
  let out = text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED)
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
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
