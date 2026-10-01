import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "worker:integration",
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    // Files share one outbox: run them sequentially (see the shared-outbox convention).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
