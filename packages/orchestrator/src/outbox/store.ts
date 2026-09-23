import type { HandlerResult } from "../events/types.js";

/** An event leased to one worker. leaseToken fences every later write about this delivery. */
export interface ClaimedEvent {
  id: string;
  eventType: string;
  payload: unknown;
  correlationId: string | null;
  aggregateType: string;
  aggregateId: string;
  /** Total claims ever (attempt number in the history table). */
  attempt: number;
  /** Claims in the current retry cycle, including this one. */
  cycleAttempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface ErrorInfo {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  /** The wrapped error (e.g. the PostgreSQL error behind a Drizzle "Failed query"). */
  cause?: ErrorInfo;
}

/** The innermost cause: usually the most useful message. */
export function rootCause(error: ErrorInfo): ErrorInfo {
  return error.cause ? rootCause(error.cause) : error;
}

export interface FailureDisposition {
  error: ErrorInfo;
  /** true → DEAD_LETTERED now; false → PENDING again after retryDelayMs. */
  deadLetter: boolean;
  retryDelayMs: number;
}

/** Transport for the outbox runner. PostgreSQL today; SQS-style transports can implement it later. */
export interface OutboxStore {
  claim(params: { workerId: string; batchSize: number; leaseMs: number }): Promise<ClaimedEvent[]>;
  /** Throws LeaseLostError if the lease expired or was taken over. */
  complete(claim: ClaimedEvent, result: HandlerResult): Promise<void>;
  /** Throws LeaseLostError if the lease expired or was taken over. */
  fail(claim: ClaimedEvent, disposition: FailureDisposition): Promise<void>;
}

/** The worker no longer holds a valid lease, so its result is discarded (another worker owns it). */
export class LeaseLostError extends Error {
  readonly code = "LEASE_LOST";

  constructor(
    readonly eventId: string,
    readonly leaseToken: string,
  ) {
    super(`lease ${leaseToken} on outbox event ${eventId} is no longer valid`);
    this.name = "LeaseLostError";
  }
}
