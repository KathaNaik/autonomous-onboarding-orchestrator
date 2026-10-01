// (M10) QStash schedule management for the production worker. Deployment tooling only: the
// runtime never needs QSTASH_TOKEN. Prints safe metadata only (never the token, signing keys,
// signatures or headers).
//
//   pnpm qstash:schedule:check                      read-only: compare with the expected schedule
//   pnpm qstash:schedule:apply --confirm            create/update the ONE schedule (by id)
//   pnpm qstash:schedule:delete --confirm-delete    remove it (explicit request only)
//   pnpm qstash:worker:wake --confirm               one signed delivery now (off-hours testing)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@upstash/qstash";
import {
  DESTINATION_TIMEOUT_SECONDS,
  MAX_RETRIES,
  SCHEDULE_BODY,
  dailyBudget,
  expectedCron,
  loadScheduleEnv,
  safeScheduleView,
  scheduleDifferences,
} from "../qstash-schedule.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const [command, ...flags] = process.argv.slice(2);

try {
  const env = loadScheduleEnv();
  const client = new Client({
    token: env.QSTASH_TOKEN,
    ...(env.QSTASH_URL && { baseUrl: env.QSTASH_URL }),
  });
  const budget = dailyBudget(MAX_RETRIES);
  if (!budget.withinFreeTier) throw new Error("schedule would exceed the QStash Free daily limit");
  const expected = {
    scheduleId: env.QSTASH_SCHEDULE_ID,
    cron: expectedCron(env.AOO_BUSINESS_TIMEZONE),
    destination: env.WORKER_QSTASH_URL,
    method: "POST",
    retries: MAX_RETRIES,
    isPaused: false,
  };

  const read = async () => {
    const all = await client.schedules.list();
    const mine = all.find((s) => s.scheduleId === env.QSTASH_SCHEDULE_ID);
    // Other schedules hitting the same worker would silently multiply the message budget.
    const others = all.filter(
      (s) => s.scheduleId !== env.QSTASH_SCHEDULE_ID && s.destination === env.WORKER_QSTASH_URL,
    ).length;
    return { mine, total: all.length, others };
  };

  if (command === "check") {
    const { mine, total, others } = await read();
    const differences = mine ? scheduleDifferences(mine, env) : ["missing"];
    print({
      status: differences.length === 0 && others === 0 ? "OK" : "MISMATCH",
      expected: safeScheduleView(expected),
      actual: mine ? safeScheduleView(mine) : null,
      differences,
      otherSchedulesForWorker: others,
      schedulesInAccount: total,
      budget,
    });
    process.exitCode = differences.length === 0 && others === 0 ? 0 : 1;
  } else if (command === "apply") {
    if (!flags.includes("--confirm")) throw new Error("apply needs --confirm");
    await client.schedules.create({
      scheduleId: env.QSTASH_SCHEDULE_ID,
      destination: env.WORKER_QSTASH_URL,
      cron: expected.cron,
      method: "POST",
      body: SCHEDULE_BODY,
      headers: { "Content-Type": "application/json" },
      retries: MAX_RETRIES,
      timeout: DESTINATION_TIMEOUT_SECONDS,
    });
    const { mine, others } = await read();
    const differences = mine ? scheduleDifferences(mine, env) : ["missing"];
    print({
      status: differences.length === 0 ? "APPLIED" : "APPLIED_WITH_DIFFERENCES",
      schedule: mine ? safeScheduleView(mine) : null,
      differences,
      otherSchedulesForWorker: others,
      budget,
    });
    process.exitCode = differences.length === 0 ? 0 : 1;
  } else if (command === "delete") {
    if (!flags.includes("--confirm-delete")) throw new Error("delete needs --confirm-delete");
    await client.schedules.delete(env.QSTASH_SCHEDULE_ID);
    print({ status: "DELETED", scheduleId: env.QSTASH_SCHEDULE_ID });
  } else if (command === "wake") {
    if (!flags.includes("--confirm")) throw new Error("wake needs --confirm");
    // One signed delivery to the same endpoint (the worker verifies it like any schedule run).
    const res = await client.publish({
      url: env.WORKER_QSTASH_URL,
      body: SCHEDULE_BODY,
      headers: { "Content-Type": "application/json" },
      retries: 0,
      timeout: DESTINATION_TIMEOUT_SECONDS,
    });
    print({ status: "PUBLISHED", messageId: "messageId" in res ? res.messageId : null });
  } else {
    throw new Error(
      "usage: qstash-schedule <check|apply --confirm|delete --confirm-delete|wake --confirm>",
    );
  }
} catch (err) {
  // Messages name variables or HTTP statuses only; the SDK never echoes the token.
  const message = err instanceof Error ? err.message : String(err);
  print({ status: "ERROR", message: message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]") });
  process.exitCode = 1;
}
