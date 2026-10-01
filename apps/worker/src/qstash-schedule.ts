import { z } from "zod";

/**
 * (M10) The single production worker schedule: QStash is only the external clock that wakes the
 * bounded worker Function; PostgreSQL remains the durable workflow/outbox source of truth.
 *
 *   CRON_TZ=<AOO_BUSINESS_TIMEZONE> * 9-16 * * 1-5   (every minute, 09:00–16:59, Mon–Fri)
 *
 * Budget on QStash Free (1000 messages/day, each retry counts as a message):
 *   8 h × 60 = 480 scheduled deliveries/day; with at most 1 retry each, worst case 960/day.
 */
export const DEFAULT_SCHEDULE_ID = "aoo-production-worker";
export const SCHEDULE_BODY = JSON.stringify({ source: "qstash-schedule" });
export const BUSINESS_HOURS_CRON = "* 9-16 * * 1-5";
export const MAX_RETRIES = 1;
export const FREE_TIER_DAILY_MESSAGES = 1000;
/** QStash waits at most this long for the worker (its function limit is 300 s). */
export const DESTINATION_TIMEOUT_SECONDS = 300;

const ianaZones = new Set(Intl.supportedValuesOf("timeZone"));

const ScheduleEnvSchema = z.object({
  QSTASH_TOKEN: z.string().trim().min(16, "QSTASH_TOKEN is required"),
  /** Optional regional API base, e.g. https://qstash-us-east-1.upstash.io. */
  QSTASH_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.url({ protocol: /^https$/ }).optional(),
  ),
  WORKER_QSTASH_URL: z.url({ protocol: /^https$/ }),
  AOO_BUSINESS_TIMEZONE: z
    .string()
    .refine((tz) => ianaZones.has(tz), "AOO_BUSINESS_TIMEZONE must be an IANA time zone"),
  QSTASH_SCHEDULE_ID: z
    .string()
    .regex(/^[a-z0-9-]{3,64}$/)
    .default(DEFAULT_SCHEDULE_ID),
});
export type ScheduleEnv = z.infer<typeof ScheduleEnvSchema>;

/** Errors name variables only, never values. */
export function loadScheduleEnv(env: NodeJS.ProcessEnv = process.env): ScheduleEnv {
  const parsed = ScheduleEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid QStash schedule configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  return parsed.data;
}

export function expectedCron(timezone: string): string {
  return `CRON_TZ=${timezone} ${BUSINESS_HOURS_CRON}`;
}

/** Deliveries per day of a `minute hour * * weekdays` business-hours expression. */
export function dailyBudget(retries: number = MAX_RETRIES) {
  const [minute, hours] = BUSINESS_HOURS_CRON.split(" ");
  const [from, to] = hours!.split("-").map(Number) as [number, number];
  const perHour = minute === "*" ? 60 : 1;
  const scheduled = (to - from + 1) * perHour;
  const worstCase = scheduled * (1 + retries);
  return {
    scheduled,
    retries,
    worstCase,
    freeTierLimit: FREE_TIER_DAILY_MESSAGES,
    withinFreeTier: worstCase <= FREE_TIER_DAILY_MESSAGES,
  };
}

export interface ScheduleLike {
  scheduleId: string;
  cron: string;
  destination: string;
  method: string;
  retries: number;
  isPaused: boolean;
  body?: string | undefined;
}

/** Only non-secret fields: never the token, signing keys, headers or caller IP. */
export function safeScheduleView(s: ScheduleLike) {
  let destination = "invalid";
  try {
    const u = new URL(s.destination);
    destination = `${u.host}${u.pathname}`;
  } catch {
    // keep "invalid"
  }
  return {
    scheduleId: s.scheduleId,
    cron: s.cron,
    destination,
    method: s.method,
    retries: s.retries,
    paused: s.isPaused,
  };
}

/** Field names that differ from the expected production schedule (empty = as expected). */
export function scheduleDifferences(actual: ScheduleLike, env: ScheduleEnv): string[] {
  const diffs: string[] = [];
  if (actual.cron !== expectedCron(env.AOO_BUSINESS_TIMEZONE)) diffs.push("cron");
  if (actual.destination !== env.WORKER_QSTASH_URL) diffs.push("destination");
  if (actual.method.toUpperCase() !== "POST") diffs.push("method");
  if (actual.retries > MAX_RETRIES) diffs.push("retries");
  if (actual.isPaused) diffs.push("paused");
  if (actual.body !== undefined && actual.body !== SCHEDULE_BODY) diffs.push("body");
  return diffs;
}
