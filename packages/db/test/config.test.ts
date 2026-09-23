import { describe, expect, it } from "vitest";
import { loadDatabaseConfig } from "../src/config.js";

describe("loadDatabaseConfig", () => {
  it("accepts a postgres URL", () => {
    const url = "postgres://aoo:aoo@localhost:5432/aoo";
    expect(loadDatabaseConfig({ DATABASE_URL: url })).toEqual({ DATABASE_URL: url });
  });

  it("rejects a missing or non-postgres URL", () => {
    expect(() => loadDatabaseConfig({})).toThrow();
    expect(() => loadDatabaseConfig({ DATABASE_URL: "mysql://localhost/aoo" })).toThrow();
  });
});
