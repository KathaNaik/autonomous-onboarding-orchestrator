import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_ID,
  SCHEDULE_BODY,
  dailyBudget,
  expectedCron,
  loadScheduleEnv,
  safeScheduleView,
  scheduleDifferences,
} from "../src/qstash-schedule.js";

const env = {
  QSTASH_TOKEN: "test-token-not-real-0123456789",
  WORKER_QSTASH_URL: "https://aoo-worker.test/api/worker/run",
  AOO_BUSINESS_TIMEZONE: "America/Phoenix",
};

describe("(M10) QStash business-hours schedule", () => {
  it("is every minute 09:00–16:59 Mon–Fri in the configured IANA time zone", () => {
    expect(expectedCron("America/Phoenix")).toBe("CRON_TZ=America/Phoenix * 9-16 * * 1-5");
    expect(loadScheduleEnv(env).QSTASH_SCHEDULE_ID).toBe(DEFAULT_SCHEDULE_ID);
  });

  it("fits QStash Free: 480 scheduled, 960 worst case with one retry, limit 1000", () => {
    expect(dailyBudget(1)).toEqual({
      scheduled: 480,
      retries: 1,
      worstCase: 960,
      freeTierLimit: 1000,
      withinFreeTier: true,
    });
    expect(dailyBudget(2).withinFreeTier).toBe(false);
  });

  it("refuses an unknown time zone and a missing token, naming variables only", () => {
    expect(() => loadScheduleEnv({ ...env, AOO_BUSINESS_TIMEZONE: "Mars/Olympus" })).toThrow(
      /AOO_BUSINESS_TIMEZONE/,
    );
    let message = "";
    try {
      loadScheduleEnv({ ...env, QSTASH_TOKEN: "" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("QSTASH_TOKEN");
    expect(message).not.toContain(env.QSTASH_TOKEN);
  });

  it("detects drift and prints only safe metadata", () => {
    const good = {
      scheduleId: DEFAULT_SCHEDULE_ID,
      cron: expectedCron("America/Phoenix"),
      destination: env.WORKER_QSTASH_URL,
      method: "POST",
      retries: 1,
      isPaused: false,
      body: SCHEDULE_BODY,
      header: { authorization: ["Bearer secret-value"] },
      callerIp: "203.0.113.9",
    };
    const parsed = loadScheduleEnv(env);
    expect(scheduleDifferences(good, parsed)).toEqual([]);
    expect(
      scheduleDifferences(
        { ...good, cron: "* * * * *", retries: 3, isPaused: true, destination: "https://x.test/" },
        parsed,
      ),
    ).toEqual(["cron", "destination", "retries", "paused"]);
    const view = JSON.stringify(safeScheduleView(good));
    expect(view).toContain("aoo-worker.test/api/worker/run");
    expect(view).not.toMatch(/secret-value|203\.0\.113|https:\/\//);
  });
});
