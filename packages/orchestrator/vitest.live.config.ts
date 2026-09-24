import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

// Explicitly invoked only (`pnpm test:servicenow:live`). WRITES to the real ServiceNow PDI.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: "orchestrator:servicenow-live",
    environment: "node",
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["packages/orchestrator/test/live/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
