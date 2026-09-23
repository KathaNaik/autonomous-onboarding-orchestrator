import { defineConfig } from "drizzle-kit";

// Generating migrations only diffs the TypeScript schema against migrations/, so no
// database connection is configured here. Apply migrations with `pnpm db:migrate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
