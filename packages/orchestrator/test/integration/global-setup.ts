import { createDatabase, runMigrations } from "@aoo/db";
import { sql } from "drizzle-orm";
import type { TestProject } from "vitest/node";
import { z } from "zod";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const TestEnvSchema = z.object({
  TEST_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default("postgres://aoo:aoo@localhost:5432/aoo"),
});

/** Creates an isolated, freshly migrated database for this run and drops it afterwards. */
export default async function setup(project: TestProject) {
  const { TEST_DATABASE_URL } = TestEnvSchema.parse(process.env);
  const dbName = `aoo_test_${Date.now()}_${process.pid}`;
  const databaseUrl = Object.assign(new URL(TEST_DATABASE_URL), { pathname: `/${dbName}` }).href;

  const admin = createDatabase(TEST_DATABASE_URL, { maxConnections: 1 });
  try {
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
  } catch (err) {
    await admin.close();
    throw new Error(
      `Cannot reach PostgreSQL at TEST_DATABASE_URL. Start it with \`docker compose up -d postgres\`.`,
      { cause: err },
    );
  }

  await runMigrations(databaseUrl);
  project.provide("databaseUrl", databaseUrl);

  return async () => {
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    await admin.close();
  };
}
