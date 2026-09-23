import { defineProject } from "vitest/config";
import { workspaceAliases } from "./vitest.shared.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "orchestrator",
    environment: "node",
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
