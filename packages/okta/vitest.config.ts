import { defineProject } from "vitest/config";
import { workspaceAliases } from "../../vitest.aliases.js";

export default defineProject({
  resolve: { alias: workspaceAliases },
  test: {
    name: "okta",
    environment: "node",
    // Live tests hit a real Okta org: never part of `pnpm test`.
    exclude: ["test/live/**", "node_modules/**"],
  },
});
