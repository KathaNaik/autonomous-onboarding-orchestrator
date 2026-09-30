import { currentTraceContext } from "@aoo/telemetry";

/**
 * (M9) Trace-context columns for an outbox insert: the active span's validated W3C traceparent
 * and tracestate, so the worker's span joins the trace that wrote the event. Empty (columns stay
 * NULL) when tracing is off or no span is active. Never baggage or caller-supplied data.
 */
export function outboxTraceColumns(): { traceParent?: string; traceState?: string } {
  const tc = currentTraceContext();
  if (!tc) return {};
  return { traceParent: tc.traceParent, ...(tc.traceState && { traceState: tc.traceState }) };
}
