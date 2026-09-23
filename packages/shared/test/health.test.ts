import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "../src/index.js";

describe("HealthResponseSchema", () => {
  const valid = {
    status: "ok",
    service: "api",
    version: "0.1.0",
    uptimeSeconds: 1.5,
    timestamp: new Date().toISOString(),
  };

  it("accepts a well-formed health response", () => {
    expect(HealthResponseSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown service", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, service: "worker" }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, timestamp: "yesterday" }).success).toBe(
      false,
    );
  });
});
