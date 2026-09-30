import { logTraceFields } from "@aoo/telemetry";
import pino from "pino";

/**
 * JSON logs to stdout; every line carries service and workerId, plus (M9) trace_id/span_id when a
 * span is active (outbox handling, coordination, provider and agent calls).
 */
export function createLogger(
  level: string,
  workerId: string,
  destination?: pino.DestinationStream,
) {
  return pino(
    { level, base: { service: "worker", workerId }, mixin: () => logTraceFields() },
    ...(destination ? [destination] : []),
  );
}
