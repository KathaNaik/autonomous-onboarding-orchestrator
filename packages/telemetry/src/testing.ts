import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";

/**
 * Test-only tracing: a globally registered provider with an in-memory exporter. Call once per test
 * file (beforeAll) and `stop()` in afterAll.
 */
export function startInMemoryTelemetry(serviceName = "aoo-test") {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  return {
    exporter,
    serviceName,
    spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    async stop() {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
export type { ReadableSpan };
