import { GitHubError } from "@aoo/github";
import { OktaError } from "@aoo/okta";
import { ServiceNowError, redactText } from "@aoo/servicenow";

export type ErrorCategory =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "VALIDATION"
  | "TIMEOUT"
  | "NETWORK"
  | "PROVIDER_UNAVAILABLE"
  | "OUTCOME_UNKNOWN"
  | "RESPONSE_INVALID"
  | "CONFLICT"
  | "OWNERSHIP"
  | "INTERNAL";

/** The only error shape that may be persisted (last_error / last_error_detail) or logged. */
export interface SanitizedExternalError {
  provider: string;
  category: ErrorCategory;
  code: string;
  httpStatus?: number;
  operation?: string;
  correlationKey?: string;
  retryable: boolean;
  message: string;
}

const SERVICENOW_CATEGORY: Record<string, ErrorCategory> = {
  AUTHENTICATION_FAILED: "AUTHENTICATION",
  PERMISSION_DENIED: "PERMISSION",
  REQUEST_INVALID: "VALIDATION",
  BAD_REQUEST: "VALIDATION",
  CONFIG_INVALID: "VALIDATION",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "NETWORK",
  INSTANCE_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  MALFORMED_RESPONSE: "RESPONSE_INVALID",
  SCHEMA_MISMATCH: "RESPONSE_INVALID",
  UNEXPECTED_STATUS: "RESPONSE_INVALID",
  NOT_FOUND: "RESPONSE_INVALID",
};

const OKTA_CATEGORY: Record<string, ErrorCategory> = {
  AUTHENTICATION_FAILED: "AUTHENTICATION",
  PERMISSION_DENIED: "PERMISSION",
  CONFIG_INVALID: "VALIDATION",
  REQUEST_INVALID: "VALIDATION",
  BAD_REQUEST: "VALIDATION",
  RATE_LIMITED: "PROVIDER_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "NETWORK",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  NOT_FOUND: "RESPONSE_INVALID",
  MALFORMED_RESPONSE: "RESPONSE_INVALID",
  UNEXPECTED_REDIRECT: "RESPONSE_INVALID",
};

const GITHUB_CATEGORY: Record<string, ErrorCategory> = { ...OKTA_CATEGORY };

const MAX_MESSAGE = 300;

/**
 * Scrubs free text: credentials (auth headers, URL userinfo, secret-like key=value), cookies,
 * URL query strings (ServiceNow encoded queries can carry employee data), SQL parameter dumps
 * ("params: ..." from the DB driver), and any caller-supplied sensitive values.
 */
export function scrubText(text: string, sensitiveValues: readonly string[] = []): string {
  let out = redactText(text)
    // Okta API tokens use the SSWS scheme (not covered by the Basic/Bearer rule).
    .replace(/\bSSWS\s+[A-Za-z0-9._~+/=-]+/gi, "SSWS [REDACTED]")
    // GitHub tokens (classic and fine-grained) and "token <value>" authorization values.
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{16,}/gi, "token [REDACTED]")
    // Public tunnel URLs (local callback endpoints) identify the operator's machine: drop them whole.
    .replace(
      /https?:\/\/[A-Za-z0-9.-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.(?:app|io|dev))\S*/gi,
      "[REDACTED-TUNNEL-URL]",
    )
    .replace(/\bparams:[\s\S]*$/i, "params: [REDACTED]")
    .replace(/\b(set-cookie|cookie)\s*[:=]\s*[^\n;]+/gi, "$1: [REDACTED]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(/\b(sysparm_[a-z_]+)=[^\s&]+/gi, "$1=[REDACTED]");
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (value && value.length >= 3) out = out.split(value).join("[REDACTED]");
  }
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/** Converts any thrown value into a SanitizedExternalError. Never includes causes or payloads. */
export function sanitizeExternalError(
  err: unknown,
  context: { provider: string; correlationKey?: string; sensitiveValues?: readonly string[] },
): SanitizedExternalError {
  const base = {
    provider: context.provider,
    ...(context.correlationKey !== undefined && { correlationKey: context.correlationKey }),
  };
  const scrub = (m: string) => scrubText(m, context.sensitiveValues);

  if (err instanceof ServiceNowError) {
    return {
      ...base,
      category: SERVICENOW_CATEGORY[err.code] ?? "INTERNAL",
      code: err.code,
      ...(err.status !== undefined && { httpStatus: err.status }),
      operation: err.operation,
      retryable: err.retryable,
      message: scrub(err.message),
    };
  }
  if (err instanceof GitHubError) {
    return {
      ...base,
      category: GITHUB_CATEGORY[err.code] ?? "INTERNAL",
      code: err.code,
      ...(err.status !== undefined && { httpStatus: err.status }),
      operation: err.operation,
      retryable: err.retryable,
      message: scrub(err.message),
    };
  }
  if (err instanceof OktaError) {
    return {
      ...base,
      category: OKTA_CATEGORY[err.code] ?? "INTERNAL",
      code: err.oktaErrorCode ? `${err.code}:${err.oktaErrorCode}` : err.code,
      ...(err.status !== undefined && { httpStatus: err.status }),
      operation: err.operation,
      retryable: err.retryable,
      message: scrub(err.message),
    };
  }
  const withCode = err as { code?: unknown; category?: unknown; retryable?: unknown };
  if (err instanceof Error && typeof withCode.category === "string") {
    return {
      ...base,
      category: withCode.category as ErrorCategory,
      code: typeof withCode.code === "string" ? withCode.code : "ERROR",
      retryable: withCode.retryable === true,
      message: scrub(err.message),
    };
  }
  return {
    ...base,
    category: "INTERNAL",
    code: "INTERNAL_ERROR",
    retryable: true,
    message: scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
  };
}

/** One-line form for last_error columns. */
export function formatSanitizedError(e: SanitizedExternalError): string {
  return `${e.provider}:${e.code}${e.httpStatus ? ` (${e.httpStatus})` : ""}: ${e.message}`;
}
