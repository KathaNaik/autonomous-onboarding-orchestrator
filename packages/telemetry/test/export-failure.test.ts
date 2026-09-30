import { describe, expect, it } from "vitest";
import { withSpan } from "../src/index.js";
import { startTelemetry } from "../src/sdk.js";

describe("observability is best-effort", () => {
  it("an unreachable OTLP collector never blocks or fails business work, and shutdown is bounded", async () => {
    // Port 9 (discard) on localhost: nothing listens, every export fails.
    const handle = startTelemetry({
      enabled: true,
      serviceName: "aoo-failure-test",
      endpoint: "http://127.0.0.1:9",
    });
    expect(handle.enabled).toBe(true);
    const started = Date.now();
    const results: number[] = [];
    for (let i = 0; i < 200; i++) {
      results.push(await withSpan("business.step", { workflowId: `wf-${i}` }, async () => i));
    }
    expect(results).toHaveLength(200);
    expect(Date.now() - started).toBeLessThan(2_000); // spans never wait on the exporter
    const shutdownStarted = Date.now();
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - shutdownStarted).toBeLessThan(5_000);
  });
});
