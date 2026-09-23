import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  close(): Promise<void>;
}

export function createDatabase(
  url: string,
  options: { maxConnections?: number } = {},
): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 10 });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}
