// (M10) Explicit production migration (never part of a build or deploy):
//
//   pnpm db:migrate:production --env-file <file OUTSIDE the repository> [--confirm]
//
// The env file holds the production connection (DATABASE_URL_UNPOOLED preferred, else
// DATABASE_URL), e.g. written by `vercel env pull <scratch path>`. Without --confirm it only
// reports. Prints counts and booleans only: never the URL, host, user or password.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { sql } from "drizzle-orm";
import { createDatabase } from "../client.js";
import { MIGRATIONS_DIR, runMigrations } from "../migrate.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2);
const fileArg = args[args.indexOf("--env-file") + 1];
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function fail(message: string): never {
  print({ status: "ERROR", message });
  process.exit(1);
}

if (args.indexOf("--env-file") < 0 || !fileArg) fail("usage: --env-file <path> [--confirm]");
const envPath = resolve(fileArg);
if (!relative(repoRoot, envPath).startsWith("..")) {
  fail("the env file must live outside the repository");
}
if (!existsSync(envPath)) fail("env file not found");
const env = parseEnv(readFileSync(envPath, "utf8"));
const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (!url) fail("DATABASE_URL_UNPOOLED / DATABASE_URL: MISSING");
let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  fail("database URL: INVALID");
}
if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail("database URL: not postgres");
const tls = parsed.searchParams.get("sslmode") === "require";

const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8")) as {
  entries: { tag: string }[];
};

async function applied(): Promise<number> {
  const handle = createDatabase(url!, { maxConnections: 1 });
  try {
    const exists = await handle.db.execute<{ t: string | null }>(
      sql`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`,
    );
    if (!exists.rows[0]?.t) return 0;
    const { rows } = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    return rows[0]?.n ?? 0;
  } finally {
    await handle.close();
  }
}

/** Error code/name only: connection errors can carry host or user details. */
function safeError(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown }; name?: unknown };
  const code = e?.cause?.code ?? e?.code;
  return `migration failed (${typeof code === "string" ? code : String(e?.name ?? "Error")})`;
}

process.on("uncaughtException", (err) => fail(safeError(err)));
process.on("unhandledRejection", (err) => fail(safeError(err)));

const before = await applied();
if (!args.includes("--confirm")) {
  print({
    status: "DRY_RUN",
    tls,
    migrationsInRepo: journal.entries.length,
    appliedBefore: before,
  });
} else {
  await runMigrations(url);
  const after = await applied();
  print({
    status: after === journal.entries.length ? "MIGRATED" : "INCOMPLETE",
    tls,
    migrationsInRepo: journal.entries.length,
    appliedBefore: before,
    appliedAfter: after,
    latest: journal.entries.at(-1)?.tag,
  });
  if (after !== journal.entries.length) process.exitCode = 1;
}
