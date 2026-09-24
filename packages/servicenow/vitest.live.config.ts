import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Explicitly invoked only: `pnpm test:servicenow:live`. Loads the git-ignored repo-root .env
// (if present) so credentials never need to be passed on the command line.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    name: "servicenow:live",
    environment: "node",
    include: ["packages/servicenow/test/live/**/*.live.test.ts"],
    root: fileURLToPath(new URL("../..", import.meta.url)),
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
