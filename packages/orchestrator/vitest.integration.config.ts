import { defineProject } from "vitest/config";
import { workspaceAliases } from "./vitest.shared.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "orchestrator:integration",
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
