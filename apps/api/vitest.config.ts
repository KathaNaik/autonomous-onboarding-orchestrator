import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "api",
    environment: "node",
    exclude: ["test/integration/**", "test/live/**", "node_modules/**"],
  },
});
