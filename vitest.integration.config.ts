import { defineConfig } from "vitest/config";

// Integration tests need a real PostgreSQL (see TEST_DATABASE_URL). `pnpm test` excludes them.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.integration.config.ts"],
  },
});
