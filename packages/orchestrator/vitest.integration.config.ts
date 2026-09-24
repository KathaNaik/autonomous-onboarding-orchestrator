import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "orchestrator:integration",
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    testTimeout: 30_000,
    // Files share one database and one outbox queue; a runner in one file would claim another
    // file's events. Run files sequentially (each file still parks leftovers in afterEach).
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
