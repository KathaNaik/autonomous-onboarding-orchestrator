export type OktaErrorCode =
  | "CONFIG_INVALID"
  | "REQUEST_INVALID"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "OUTCOME_UNKNOWN"
  | "MALFORMED_RESPONSE"
  | "UNEXPECTED_REDIRECT";

/**
 * Okta adapter failure. Messages are built from safe parts only (operation, status, Okta error
 * code): never the API token, request headers, profile values or response text.
 */
export class OktaError extends Error {
  readonly code: OktaErrorCode;
  readonly operation: string;
  readonly status: number | undefined;
  /** Whether retrying the same request later could succeed. */
  readonly retryable: boolean;
  /** For writes: the request provably did not take effect (safe to retry without reconciling). */
  readonly notSent: boolean;
  /** Provider-suggested wait (Retry-After / X-Rate-Limit-Reset), capped. */
  readonly retryAfterMs: number | undefined;
  /** Okta's error code (e.g. E0000001), when the body carried one. */
  readonly oktaErrorCode: string | undefined;

  constructor(
    code: OktaErrorCode,
    operation: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      notSent?: boolean;
      retryAfterMs?: number;
      oktaErrorCode?: string;
    } = {},
  ) {
    super(`Okta ${operation}: ${message}`);
    this.name = new.target.name;
    this.code = code;
    this.operation = operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.notSent = options.notSent ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.oktaErrorCode = options.oktaErrorCode;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      status: this.status,
      retryable: this.retryable,
      notSent: this.notSent,
      oktaErrorCode: this.oktaErrorCode,
      message: this.message,
    };
  }
}
