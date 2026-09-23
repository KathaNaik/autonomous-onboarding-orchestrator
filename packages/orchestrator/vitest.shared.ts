import { fileURLToPath } from "node:url";

export const workspaceAliases = {
  "@aoo/db": fileURLToPath(new URL("../db/src/index.ts", import.meta.url)),
  "@aoo/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
};
