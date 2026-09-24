import type { ErrorCategory } from "./sanitize.js";

export type ExternalOperationErrorCode =
  | "NOT_FOUND"
  | "PROVIDER_NOT_CONFIGURED"
  | "BUSY"
  | "OWNERSHIP_LOST"
  | "STOPPED"
  | "FAILED"
  | "CONFLICT"
  | "RETRY_LATER"
  | "IDEMPOTENCY_CONFLICT";

/**
 * Outcome of an external-operation attempt that did not end in SUCCEEDED. `retryable` tells the
 * outbox handler whether to retry (with backoff) or dead-letter. Messages are already sanitized.
 */
export class ExternalOperationError extends Error {
  constructor(
    readonly code: ExternalOperationErrorCode,
    readonly category: ErrorCategory,
    readonly retryable: boolean,
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "ExternalOperationError";
  }
}
