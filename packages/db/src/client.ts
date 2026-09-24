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
  options: {
    maxConnections?: number;
    /**
     * Called when an IDLE pooled connection dies (database restart, failover, admin
     * termination). The pool discards that client and later queries reconnect. Without a
     * listener, node-postgres re-throws this as an uncaught error and crashes the process.
     */
    onIdleClientError?: (error: Error) => void;
  } = {},
): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 10 });
  pool.on("error", (error) => options.onIdleClientError?.(error));
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}
