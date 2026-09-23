import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "../src/outbox/backoff.js";

const policy = { backoffBaseMs: 1000, backoffMaxMs: 60_000 };

describe("computeBackoffMs", () => {
  it("doubles the cap per failed attempt, bounded to [cap/2, cap]", () => {
    for (const [n, cap] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
      [6, 32_000],
    ] as const) {
      expect(computeBackoffMs(n, policy, () => 0)).toBe(cap / 2);
      expect(computeBackoffMs(n, policy, () => 1)).toBe(cap);
      expect(computeBackoffMs(n, policy, () => 0.5)).toBe((cap * 3) / 4);
    }
  });

  it("never exceeds backoffMaxMs", () => {
    expect(computeBackoffMs(30, policy, () => 1)).toBe(60_000);
    expect(computeBackoffMs(30, policy, () => 0)).toBe(30_000);
  });

  it("jitters: different random draws give different delays within bounds", () => {
    const delays = new Set(Array.from({ length: 50 }, () => computeBackoffMs(4, policy)));
    expect(delays.size).toBeGreaterThan(1);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});
