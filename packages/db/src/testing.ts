import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

const TestEnvSchema = z.object({
  TEST_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default("postgres://aoo:aoo@localhost:5432/aoo"),
});

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * For integration tests: creates a fresh, fully migrated database next to TEST_DATABASE_URL.
 * Call drop() when done; it force-closes remaining connections.
 */
export async function createTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDatabase> {
  const { TEST_DATABASE_URL } = TestEnvSchema.parse(env);
  const name = `aoo_test_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const url = Object.assign(new URL(TEST_DATABASE_URL), { pathname: `/${name}` }).href;

  const admin = createDatabase(TEST_DATABASE_URL, { maxConnections: 1 });
  try {
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } catch (err) {
    await admin.close();
    throw new Error(
      "Cannot reach PostgreSQL at TEST_DATABASE_URL. Start it with `docker compose up -d postgres`.",
      { cause: err },
    );
  }

  await runMigrations(url);

  return {
    url,
    async drop() {
      await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      await admin.close();
    },
  };
}
