export type GitHubErrorCode =
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
 * GitHub adapter failure. Messages are built from safe parts only (operation, status): never the
 * token, request headers or response text.
 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly operation: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** For writes: the request provably did not take effect. */
  readonly notSent: boolean;
  /** Provider-suggested wait (Retry-After / x-ratelimit-reset), capped. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: GitHubErrorCode,
    operation: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      notSent?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(`GitHub ${operation}: ${message}`);
    this.name = new.target.name;
    this.code = code;
    this.operation = operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.notSent = options.notSent ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      status: this.status,
      retryable: this.retryable,
      notSent: this.notSent,
      message: this.message,
    };
  }
}
