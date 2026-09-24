import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "servicenow",
    environment: "node",
    // Live tests hit a real ServiceNow instance: never part of `pnpm test`.
    exclude: ["test/live/**", "node_modules/**"],
  },
});
