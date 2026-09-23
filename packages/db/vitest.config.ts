import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@aoo/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "db",
    environment: "node",
  },
});
