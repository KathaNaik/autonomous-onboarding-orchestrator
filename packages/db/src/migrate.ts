import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

// Resolves to packages/db/migrations from both src/ and dist/.
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDatabase(databaseUrl, { maxConnections: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await handle.close();
  }
}
