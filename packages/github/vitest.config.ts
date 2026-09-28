import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "github",
    environment: "node",
    // Live tests hit a real GitHub: never part of `pnpm test`.
    exclude: ["test/live/**", "node_modules/**"],
  },
});
