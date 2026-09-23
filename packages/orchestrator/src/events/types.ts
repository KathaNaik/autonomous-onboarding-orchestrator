// Transport-independent event handling contracts. Handlers never see PostgreSQL leases or
// SQS receipt handles; the same handlers can run behind the local outbox worker or AWS SQS.

/** One delivery of an event to a handler. Deliveries are at-least-once; handlers must be idempotent. */
export interface EventEnvelope {
  id: string;
  type: string;
  payload: unknown;
  correlationId: string | null;
  aggregateType: string;
  aggregateId: string;
  /** 1-based delivery attempt within the current retry cycle. */
  deliveryAttempt: number;
}

/** Structured logger (pino-compatible subset). */
export interface EventLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HandlerContext {
  logger: EventLogger;
}

export interface HandlerResult {
  /** "skipped" = nothing to do (already done, or not applicable); still an acknowledgement. */
  status: "processed" | "skipped";
  detail?: Record<string, unknown>;
}

export type EventHandler = (event: EventEnvelope, ctx: HandlerContext) => Promise<HandlerResult>;
export type EventHandlerRegistry = Readonly<Record<string, EventHandler>>;

/** Retrying cannot help (malformed payload, unknown event type, missing aggregate): dead-letter now. */
export class PermanentEventError extends Error {
  readonly code = "PERMANENT_EVENT_ERROR";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentEventError";
  }
}

export const noopLogger: EventLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
