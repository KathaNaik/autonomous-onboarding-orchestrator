import type { EXTERNAL_PROVIDERS } from "@aoo/db";

/** What the provider's authoritative state says about the desired outcome. */
export type HandlerProbe =
  /** The desired state exists and is verified; ids become the operation's external ids. */
  | { kind: "satisfied"; externalId: string; externalReference: string }
  /** The desired state does not exist (yet). */
  | { kind: "absent" }
  /** The provider state contradicts the request: stop automation, never guess. */
  | { kind: "conflict"; code: string; message: string; evidence?: Record<string, unknown> };

/**
 * How a provider error affects durability:
 *  - not_sent: the write provably did not take effect (safe to retry without reconciling)
 *  - outcome_unknown: the write may have taken effect (persist OUTCOME_UNKNOWN, reconcile)
 *  - failed: deterministic (authentication, permission, invalid request): stop as FAILED
 *  - retry: a transient read/infrastructure failure: release and retry later
 */
export type FailureClass = "not_sent" | "outcome_unknown" | "failed" | "retry";

/**
 * Provider-specific logic for one operation type, executed by the generic durable executor
 * (claim, lease, fencing, outcome-unknown, bounded reconciliation, sanitized errors, audit).
 * Handlers never touch the database; the executor owns durability.
 */
export interface ExternalOperationHandler<Request = unknown> {
  readonly provider: (typeof EXTERNAL_PROVIDERS)[number];
  readonly operationType: string;
  /** Validates the stored request (a malformed request is a FAILED operation). */
  parseRequest(raw: unknown): Request;
  /** Values to scrub from any persisted or logged error text. */
  sensitiveValues(request: Request): readonly string[];
  /** Reads the authoritative provider state (runs before any write, and after uncertainty). */
  reconcile(request: Request, ctx: { signal: AbortSignal }): Promise<HandlerProbe>;
  /** The single write. Its result is passed to `verify`. */
  perform(request: Request, ctx: { signal: AbortSignal }): Promise<unknown>;
  /** Authoritative read-back after a successful write. */
  verify(request: Request, performed: unknown, ctx: { signal: AbortSignal }): Promise<HandlerProbe>;
  classify(err: unknown): FailureClass;
}
