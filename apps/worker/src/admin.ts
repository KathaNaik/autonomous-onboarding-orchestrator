// Operator CLI for the outbox dead-letter queue.
//   pnpm worker:admin dead-letters [--limit 50]
//   pnpm worker:admin redrive --id <uuid> [--id <uuid> ...] --reason "<why>" [--actor <who>] [--dry-run]
//   pnpm worker:admin external-ops [--status FAILED] [--limit 50]
//   pnpm worker:admin reopen-operation --id <uuid> --reason "<why>" [--actor <who>]   (FAILED only)
// Redrive only ever touches events that are currently DEAD_LETTERED, and is audited.
import { parseArgs } from "node:util";
import { createDatabase, loadDatabaseConfig } from "@aoo/db";
import { EXTERNAL_OPERATION_STATUSES, externalOperations } from "@aoo/db";
import { createExternalOperationService, createPostgresOutboxStore } from "@aoo/orchestrator";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    id: { type: "string", multiple: true, default: [] },
    reason: { type: "string" },
    actor: { type: "string", default: `ops:${process.env.USER ?? "unknown"}` },
    limit: { type: "string", default: "50" },
    "dry-run": { type: "boolean", default: false },
    status: { type: "string" },
  },
});

const database = createDatabase(loadDatabaseConfig().DATABASE_URL, { maxConnections: 1 });
const store = createPostgresOutboxStore(database.db);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  if (command === "dead-letters") {
    const limit = z.coerce.number().int().min(1).max(1000).parse(values.limit);
    const rows = await store.listDeadLetters(limit);
    print(
      rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        aggregate: `${r.aggregateType}/${r.aggregateId}`,
        attempts: r.attempts,
        redriveCount: r.redriveCount,
        deadLetteredAt: r.deadLetteredAt,
        lastError: r.lastError,
      })),
    );
  } else if (command === "redrive") {
    const args = z
      .object({
        ids: z.array(z.uuid()).min(1, "pass at least one --id"),
        reason: z.string().trim().min(3, "--reason is required"),
        actor: z.string().trim().min(1),
      })
      .parse({ ids: values.id, reason: values.reason, actor: values.actor });
    if (values["dry-run"]) {
      const dead = new Set((await store.listDeadLetters(1000)).map((r) => r.id));
      print({ dryRun: true, wouldRedrive: args.ids.filter((id) => dead.has(id)) });
    } else {
      print(await store.redrive({ eventIds: args.ids, actor: args.actor, reason: args.reason }));
    }
  } else if (command === "external-ops") {
    const limit = z.coerce.number().int().min(1).max(1000).parse(values.limit);
    const status = z.enum(EXTERNAL_OPERATION_STATUSES).optional().parse(values.status);
    const rows = await database.db
      .select()
      .from(externalOperations)
      .where(status ? eq(externalOperations.status, status) : undefined)
      .orderBy(desc(externalOperations.updatedAt))
      .limit(limit);
    // Deliberately omits `request` (employee data); shows sanitized error fields only.
    print(
      rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        operationType: r.operationType,
        status: r.status,
        correlationKey: r.correlationKey,
        externalReference: r.externalReference,
        externalId: r.externalId,
        attempts: r.attempts,
        lastError: r.lastError,
        evidence: r.evidence,
        updatedAt: r.updatedAt,
      })),
    );
  } else if (command === "reopen-operation") {
    const args = z
      .object({
        id: z.uuid(),
        reason: z.string().trim().min(3, "--reason is required"),
        actor: z.string().trim().min(1),
      })
      .parse({ id: values.id[0], reason: values.reason, actor: values.actor });
    const row = await createExternalOperationService(database.db).reopen(args.id, {
      actor: args.actor,
      reason: args.reason,
    });
    print({ reopened: row.id, status: row.status });
  } else {
    console.error(
      "usage: worker:admin <dead-letters|redrive|external-ops|reopen-operation> [options] (see src/admin.ts)",
    );
    process.exitCode = 2;
  }
} finally {
  await database.close();
}
