import { redactText } from "./redact.js";

export type ServiceNowErrorCode =
  | "CONFIG_INVALID"
  | "REQUEST_INVALID"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INSTANCE_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "SCHEMA_MISMATCH"
  | "UNEXPECTED_STATUS";

/**
 * Base class for every adapter error. Messages are built from safe parts only (operation,
 * status, codes) and pass through redaction; they never include credentials, headers or bodies.
 */
export class ServiceNowError extends Error {
  readonly code: ServiceNowErrorCode;
  readonly operation: string;
  readonly status: number | undefined;
  /** Whether retrying the same request later could succeed. */
  readonly retryable: boolean;

  constructor(
    code: ServiceNowErrorCode,
    operation: string,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(redactText(`ServiceNow ${operation}: ${message}`), { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.operation = operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }

  /** Safe structured form for logs. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export class ServiceNowConfigError extends ServiceNowError {
  constructor(readonly issues: string[]) {
    super("CONFIG_INVALID", "config", `invalid configuration: ${issues.join("; ")}`);
  }
}

/** Caller input rejected before any request was sent. */
export class ServiceNowRequestError extends ServiceNowError {
  constructor(operation: string, message: string) {
    super("REQUEST_INVALID", operation, message);
  }
}

/** 401: wrong username/password, locked or inactive integration user. */
export class ServiceNowAuthError extends ServiceNowError {
  constructor(operation: string) {
    super("AUTHENTICATION_FAILED", operation, "authentication failed (401)", { status: 401 });
  }
}

/** 403: authenticated, but roles/ACLs do not allow this read. */
export class ServiceNowPermissionError extends ServiceNowError {
  constructor(operation: string, detail?: string) {
    super("PERMISSION_DENIED", operation, `permission denied (403)${detail ? `: ${detail}` : ""}`, {
      status: 403,
    });
  }
}

export class ServiceNowTimeoutError extends ServiceNowError {
  constructor(operation: string, timeoutMs: number, attempts: number) {
    super("TIMEOUT", operation, `timed out after ${timeoutMs}ms (${attempts} attempt(s))`, {
      retryable: true,
    });
  }
}

/** Network failure, 5xx, 429, a hibernating PDI, or a non-JSON response. */
export class ServiceNowUnavailableError extends ServiceNowError {
  constructor(
    operation: string,
    message: string,
    options: { status?: number; cause?: unknown; instanceUnavailable?: boolean } = {},
  ) {
    super(
      options.instanceUnavailable ? "INSTANCE_UNAVAILABLE" : "UNAVAILABLE",
      operation,
      message,
      {
        ...(options.status !== undefined && { status: options.status }),
        retryable: true,
        cause: options.cause,
      },
    );
  }
}

/** The response could not be parsed or did not match the expected schema. */
export class ServiceNowResponseError extends ServiceNowError {
  constructor(
    code:
      "MALFORMED_RESPONSE" | "SCHEMA_MISMATCH" | "UNEXPECTED_STATUS" | "BAD_REQUEST" | "NOT_FOUND",
    operation: string,
    message: string,
    status?: number,
  ) {
    super(code, operation, message, status === undefined ? {} : { status });
  }
}
