import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

// Explicitly invoked only, one file per script: `pnpm test:servicenow:approval:live` (PDI, the
// business rule and a public tunnel to APPROVAL_LIVE_PORT) and `pnpm test:github:live` (the GitHub
// test org). Loads the git-ignored repo-root .env.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: "api:live",
    environment: "node",
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["apps/api/test/live/**/*.live.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
