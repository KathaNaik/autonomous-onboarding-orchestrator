import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  createTraceState,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

/**
 * M9 telemetry helpers. Only the OpenTelemetry API is used here: with no SDK registered every call
 * is a cheap no-op, so business code never depends on a collector (observability is best-effort).
 * Nothing here records secrets: attributes come from a closed set of `aoo.*` keys with scrubbed,
 * length-capped values; errors are recorded as a sanitized type/code, never as messages or stacks.
 */

export const TRACER_NAME = "aoo";

/** Semantic attribute names (closed set). */
export const AOO_ATTR = Object.freeze({
  workflowId: "aoo.workflow.id",
  employeeId: "aoo.employee.id",
  agentRunId: "aoo.agent.run_id",
  agentName: "aoo.agent.name",
  onboardingPlanRunId: "aoo.onboarding_plan.run_id",
  provisioningPlanId: "aoo.provisioning.plan_id",
  accessRequestId: "aoo.access_request.id",
  resourceId: "aoo.resource.id",
  externalOperationId: "aoo.external_operation.id",
  operationType: "aoo.external_operation.type",
  outboxEventId: "aoo.outbox.event_id",
  outboxEventType: "aoo.outbox.event_type",
  deliveryAttempt: "aoo.outbox.delivery_attempt",
  provider: "aoo.provider",
  requestId: "aoo.request.id",
  outcome: "aoo.outcome",
  errorType: "aoo.error.type",
});
export type AooAttributeKey = keyof typeof AOO_ATTR;
export type AooAttributeInput = Partial<
  Record<AooAttributeKey, string | number | boolean | null | undefined>
>;

const MAX_VALUE = 200;

/** Redacts credential-like substrings (keys, tokens, auth headers, URL credentials, queries). */
export function scrubTelemetryText(text: string): string {
  const out = text
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[REDACTED]")
    .replace(/\b(bearer|basic|ssws|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|cookie|set-cookie|x-api-key|x-aoo-signature|x-hris-signature)\s*[:=]\s*\S+/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    );
  return out.length > MAX_VALUE ? `${out.slice(0, MAX_VALUE)}…` : out;
}

/** Builds span attributes from the closed `aoo.*` key set; drops empty values, scrubs strings. */
export function aooAttributes(input: AooAttributeInput): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(input) as [AooAttributeKey, unknown][]) {
    const name = AOO_ATTR[key];
    if (!name || value === null || value === undefined) continue;
    if (typeof value === "string") {
      if (value.length > 0) out[name] = scrubTelemetryText(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
    }
  }
  return out;
}

/** A stable, safe error type for spans and logs: the error's code or class name, never its text. */
export function errorType(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; category?: unknown } | null;
  const raw =
    (typeof e?.code === "string" && e.code) ||
    (typeof e?.category === "string" && e.category) ||
    (typeof e?.name === "string" && e.name) ||
    "Error";
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(raw) ? raw : "Error";
}

/**
 * Runs `fn` inside an active span. Errors are recorded as status ERROR with a sanitized type only
 * (no message, no stack) and rethrown unchanged. With no SDK registered this is a no-op wrapper.
 */
export async function withSpan<T>(
  name: string,
  attributes: AooAttributeInput,
  fn: (span: Span) => Promise<T>,
  options: { parent?: Context | undefined; kind?: SpanKind } = {},
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { attributes: aooAttributes(attributes), kind: options.kind ?? SpanKind.INTERNAL },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        const type = errorType(err);
        span.setAttribute(AOO_ATTR.errorType, type);
        span.setStatus({ code: SpanStatusCode.ERROR, message: type });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Sets additional safe attributes on the active span (no-op without one). */
export function annotateActiveSpan(attributes: AooAttributeInput): void {
  trace.getActiveSpan()?.setAttributes(aooAttributes(attributes));
}

const TRACE_PARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_STATE = /^[A-Za-z0-9_\-*/@=,.;:+ ]{1,256}$/;

/** Validates a W3C traceparent (version 00, non-zero ids). Returns it normalized, or null. */
export function parseTraceParent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  const m = TRACE_PARENT.exec(v);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return v;
}

/** Validates a tracestate (bounded length and charset). Returns it, or null. */
export function parseTraceState(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return TRACE_STATE.test(v) ? v : null;
}

export interface TraceContextCarrier {
  traceParent: string;
  traceState: string | null;
}

/** The active span's W3C context, for durable propagation (e.g. an outbox row), or null. */
export function currentTraceContext(): TraceContextCarrier | null {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !trace.isSpanContextValid(sc)) return null;
  const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, "0");
  const traceParent = parseTraceParent(`00-${sc.traceId}-${sc.spanId}-${flags}`);
  if (!traceParent) return null;
  return { traceParent, traceState: parseTraceState(sc.traceState?.serialize()) };
}

/**
 * A context whose remote parent is the given traceparent (validated), or undefined. Only
 * traceparent/tracestate are honored: no baggage from callers or durable events.
 */
export function contextFromTraceParent(
  traceParent: unknown,
  traceState?: unknown,
): Context | undefined {
  const tp = parseTraceParent(traceParent);
  if (!tp) return undefined;
  const [, traceId, spanId, flags] = TRACE_PARENT.exec(tp)!;
  const ts = parseTraceState(traceState);
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: traceId!,
    spanId: spanId!,
    traceFlags: Number.parseInt(flags!, 16),
    isRemote: true,
    ...(ts && { traceState: createTraceState(ts) }),
  });
}

/** Trace id of a traceparent, or null. */
export function traceIdOf(traceParent: unknown): string | null {
  const tp = parseTraceParent(traceParent);
  return tp ? tp.slice(3, 35) : null;
}

/** `{ trace_id, span_id }` of the active span for log correlation, or `{}` (no undefined noise). */
export function logTraceFields(): { trace_id?: string; span_id?: string } {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export { ROOT_CONTEXT, SpanKind, context as otelContext, trace as otelTrace };
export type { Context as OtelContext, Span as OtelSpan };
