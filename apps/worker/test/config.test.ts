import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://aoo:aoo@localhost:5432/aoo" };

describe("worker config", () => {
  it("applies defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      OUTBOX_BATCH_SIZE: 10,
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_LEASE_MS: 30_000,
      OUTBOX_MAX_ATTEMPTS: 5,
      OUTBOX_BACKOFF_BASE_MS: 1000,
      OUTBOX_BACKOFF_MAX_MS: 300_000,
      WORKER_HEALTH_PORT: 4100,
    });
    expect(loadConfig(base).WORKER_ID).toMatch(/-\d+$/);
  });

  it("coerces numeric strings", () => {
    expect(
      loadConfig({ ...base, OUTBOX_BATCH_SIZE: "25", OUTBOX_MAX_ATTEMPTS: "8" }),
    ).toMatchObject({
      OUTBOX_BATCH_SIZE: 25,
      OUTBOX_MAX_ATTEMPTS: 8,
    });
  });

  it.each([
    ["missing DATABASE_URL", {}],
    ["non-postgres URL", { DATABASE_URL: "mysql://x/y" }],
    ["zero batch size", { ...base, OUTBOX_BATCH_SIZE: "0" }],
    ["oversized batch", { ...base, OUTBOX_BATCH_SIZE: "1000" }],
    ["non-numeric lease", { ...base, OUTBOX_LEASE_MS: "soon" }],
    ["zero max attempts", { ...base, OUTBOX_MAX_ATTEMPTS: "0" }],
    [
      "backoff max below base",
      { ...base, OUTBOX_BACKOFF_BASE_MS: "5000", OUTBOX_BACKOFF_MAX_MS: "1000" },
    ],
    [
      "lease not longer than poll interval",
      { ...base, OUTBOX_LEASE_MS: "500", OUTBOX_POLL_INTERVAL_MS: "500" },
    ],
  ])("rejects %s", (_, env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
