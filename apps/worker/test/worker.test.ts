import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { noopLogger, type OutboxRunner, type RunSummary } from "@aoo/orchestrator";
import { describe, expect, it, vi } from "vitest";
import { createHealthServer, healthStatus } from "../src/health.js";
import { createWorkerLoop } from "../src/worker.js";

const summary = (claimed: number): RunSummary => ({
  claimed,
  succeeded: claimed,
  retried: 0,
  deadLettered: 0,
  leaseLost: 0,
});

function loopWith(runOnce: OutboxRunner["runOnce"], batchSize = 5) {
  return createWorkerLoop({
    workerId: "w-test",
    runner: { runOnce },
    batchSize,
    pollIntervalMs: 10,
    logger: noopLogger,
    maxErrorDelayMs: 20,
  });
}

describe("worker loop", () => {
  it("polls, accumulates totals, and stops gracefully after the in-flight batch", async () => {
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      if (calls === 3) loop.stop();
      return summary(calls === 1 ? 2 : 0);
    });
    await loop.run();
    expect(calls).toBe(3);
    expect(loop.state).toMatchObject({ lastPollOk: true, stopping: true });
    expect(loop.state.totals).toMatchObject({ claimed: 2, succeeded: 2 });
  });

  it("polls again immediately after a full batch", async () => {
    const runOnce = vi.fn<OutboxRunner["runOnce"]>();
    const loop = loopWith(runOnce, 3);
    runOnce
      .mockResolvedValueOnce(summary(3))
      .mockResolvedValueOnce(summary(3))
      .mockImplementationOnce(async () => {
        loop.stop();
        return summary(0);
      });
    const started = Date.now();
    await loop.run();
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("survives infrastructure errors, reports them, and recovers", async () => {
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("connection refused");
      loop.stop();
      return summary(0);
    });
    await loop.run();
    expect(calls).toBe(3);
    expect(loop.state).toMatchObject({
      lastPollOk: true,
      consecutiveFailures: 0,
      lastPollError: null,
    });
  });

  it("stop() interrupts the idle sleep", async () => {
    const loop = createWorkerLoop({
      workerId: "w",
      runner: { runOnce: async () => summary(0) },
      batchSize: 5,
      pollIntervalMs: 60_000,
      logger: noopLogger,
    });
    const done = loop.run();
    await new Promise((r) => setTimeout(r, 20));
    loop.stop();
    await expect(
      Promise.race([
        done.then(() => "stopped"),
        new Promise((r) => setTimeout(() => r("hung"), 500)),
      ]),
    ).resolves.toBe("stopped");
  });
});

describe("health", () => {
  const thresholds = { stallAfterMs: 1000 };
  const loopState = () => loopWith(async () => summary(0)).state;

  it("is live but not ready before the first successful poll", () => {
    const s = loopState();
    expect(healthStatus(s, thresholds)).toMatchObject({ live: true, ready: false });
  });

  it("is ready after a successful poll, and not ready once the database fails", () => {
    const s = loopState();
    Object.assign(s, { lastLoopAt: new Date(), lastPollAt: new Date(), lastPollOk: true });
    expect(healthStatus(s, thresholds)).toMatchObject({
      live: true,
      ready: true,
      body: { status: "ready" },
    });
    Object.assign(s, { lastPollOk: false, lastPollError: "ECONNREFUSED" });
    expect(healthStatus(s, thresholds)).toMatchObject({
      ready: false,
      body: { status: "not_ready", lastPollError: "ECONNREFUSED" },
    });
  });

  it("reports a stalled loop as not live", () => {
    const s = loopState();
    Object.assign(s, { lastLoopAt: new Date(Date.now() - 5000), lastPollOk: true });
    expect(healthStatus(s, thresholds)).toMatchObject({
      live: false,
      ready: false,
      body: { status: "stalled" },
    });
  });

  it("is not ready while shutting down", () => {
    const s = loopState();
    Object.assign(s, { lastLoopAt: new Date(), lastPollOk: true, stopping: true });
    expect(healthStatus(s, thresholds).ready).toBe(false);
  });

  it("serves /live and /ready over HTTP with matching status codes", async () => {
    const s = loopState();
    const server = createHealthServer(s, thresholds).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;
    try {
      expect((await fetch(url("/live"))).status).toBe(200);
      expect((await fetch(url("/ready"))).status).toBe(503);
      Object.assign(s, { lastLoopAt: new Date(), lastPollOk: true });
      const ready = await fetch(url("/ready"));
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ workerId: "w-test", status: "ready" });
      expect((await fetch(url("/nope"))).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
