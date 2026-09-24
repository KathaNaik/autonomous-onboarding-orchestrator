import { sql } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import { createDatabase } from "../../src/index.js";

describe("createDatabase", () => {
  it("survives an idle connection being terminated by the server, and reconnects", async () => {
    const errors: string[] = [];
    const handle = createDatabase(inject("databaseUrl"), {
      maxConnections: 1,
      onIdleClientError: (e) => errors.push((e as { code?: string }).code ?? e.message),
    });
    const admin = createDatabase(inject("databaseUrl"), { maxConnections: 1 });
    try {
      const [{ pid }] = (
        await handle.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      ).rows as [{ pid: number }];
      await admin.db.execute(sql`SELECT pg_terminate_backend(${pid})`); // like a DB restart
      await new Promise((r) => setTimeout(r, 200));
      expect(errors).toEqual(["57P01"]); // reported, not thrown: the process did not crash
      const [{ ok }] = (await handle.db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)).rows as [
        { ok: number },
      ];
      expect(ok).toBe(1);
    } finally {
      await handle.close();
      await admin.close();
    }
  });
});
