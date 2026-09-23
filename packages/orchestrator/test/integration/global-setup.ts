import { createTestDatabase } from "@aoo/db/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Creates an isolated, freshly migrated database for this run and drops it afterwards. */
export default async function setup(project: TestProject) {
  const database = await createTestDatabase();
  project.provide("databaseUrl", database.url);
  return () => database.drop();
}
