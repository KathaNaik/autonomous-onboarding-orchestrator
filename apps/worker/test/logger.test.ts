import { withSpan } from "@aoo/telemetry";
import { startInMemoryTelemetry } from "@aoo/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

let otel: ReturnType<typeof startInMemoryTelemetry>;
beforeAll(() => {
  otel = startInMemoryTelemetry();
});
afterAll(() => otel.stop());

describe("worker logs (M9)", () => {
  it("carry trace_id/span_id inside a span and no trace noise outside one", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", "w-1", { write: (l: string) => void lines.push(l) });
    logger.info({ eventId: "e1" }, "outside");
    await withSpan("outbox.process x", { outboxEventId: "e1" }, async () => {
      logger.info({ eventId: "e1", workflowId: "wf" }, "inside");
    });
    const [outside, inside] = lines.map((l) => JSON.parse(l));
    expect(outside).not.toHaveProperty("trace_id");
    expect(outside).not.toHaveProperty("span_id");
    const span = otel.spans().find((s) => s.name === "outbox.process x")!;
    expect(inside).toMatchObject({
      service: "worker",
      workerId: "w-1",
      eventId: "e1",
      workflowId: "wf",
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
  });
});
