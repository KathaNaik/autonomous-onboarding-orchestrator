import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "api:integration",
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    testTimeout: 30_000,
    // (M9) The end-to-end observability test runs the real outbox runner, which would claim other
    // files' events: files share one database and one outbox queue, so run them sequentially.
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
