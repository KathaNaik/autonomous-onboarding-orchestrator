import { randomUUID } from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanKind,
  TRACER_NAME,
  aooAttributes,
  contextFromTraceParent,
  otelContext,
  otelTrace,
  type OtelContext,
  type OtelSpan,
} from "@aoo/telemetry";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Response header carrying the request id (also the log field `requestId`). */
export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * (M9) Request id: a caller-supplied `X-Request-Id` is reused only when it is short and made of
 * safe characters; anything else (missing, oversized, odd characters) gets a fresh UUID.
 */
export function normalizeRequestId(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && REQUEST_ID.test(v) ? v : randomUUID();
}

const state = new WeakMap<FastifyRequest, { span: OtelSpan; ctx: OtelContext }>();

/**
 * (M9) One SERVER span per request, named by method and route pattern (never the raw URL with
 * ids or query strings). A valid incoming W3C `traceparent` is honored; baggage is ignored.
 * The span context is re-entered before the handler so outbox writes inherit it. No-op without
 * a registered SDK. Returns `X-Request-Id` on every response.
 */
export function registerRequestObservability(app: FastifyInstance): void {
  const tracer = otelTrace.getTracer(TRACER_NAME);
  app.addHook("onRequest", (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    const parent =
      contextFromTraceParent(request.headers.traceparent, request.headers.tracestate) ??
      ROOT_CONTEXT;
    const span = tracer.startSpan(
      `HTTP ${request.method}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": request.method,
          ...aooAttributes({ requestId: request.id }),
        },
      },
      parent,
    );
    const ctx = otelTrace.setSpan(parent, span);
    state.set(request, { span, ctx });
    otelContext.with(ctx, done);
  });
  // Body parsing may leave the async context; re-enter it right before the handler.
  app.addHook("preHandler", (request, _reply, done) => {
    const s = state.get(request);
    if (s) otelContext.with(s.ctx, done);
    else done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const s = state.get(request);
    if (s) {
      const route = request.routeOptions.url ?? "unmatched";
      s.span.updateName(`HTTP ${request.method} ${route}`);
      s.span.setAttributes({ "http.route": route, "http.response.status_code": reply.statusCode });
      if (reply.statusCode >= 500)
        s.span.setStatus({ code: 2, message: `HTTP ${reply.statusCode}` });
      s.span.end();
      state.delete(request);
    }
    done();
  });
}
