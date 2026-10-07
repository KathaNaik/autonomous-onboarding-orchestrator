import { auditEvents, createDatabase, operatorAccounts, type DatabaseHandle } from "@aoo/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createOperatorAccountService, verifyPassword } from "../../src/index.js";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await handle.close();
});

const PASSWORD = "correct horse battery staple";
const email = (tag: string) => `${tag}.${Math.random().toString(36).slice(2, 8)}@example.com`;
const recentAccounts = async () =>
  (
    await handle.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM operator_accounts
      WHERE created_at > clock_timestamp() - interval '24 hours'`)
  ).rows[0]!.n;
const service = (signupDailyLimit = 10_000) =>
  createOperatorAccountService(handle.db, { signupDailyLimit });
const rowOf = async (address: string) =>
  (await handle.db.select().from(operatorAccounts).where(eq(operatorAccounts.email, address)))[0];

describe("(M12) operator accounts", () => {
  it("sign-up stores only a salted scrypt hash, lower-cases the email and audits without secrets", async () => {
    const address = email("ada");
    const result = await service().signUp({
      email: ` ${address.toUpperCase()} `,
      password: PASSWORD,
    });
    expect(result).toEqual({ operatorId: address });
    const row = (await rowOf(address))!;
    expect(row.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(true);
    const [audit] = await handle.db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.eventType} = 'operator.account_created' AND ${auditEvents.actor} = ${`hr:${address}`}`,
      );
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.payload)).not.toMatch(/scrypt|horse/);
    // The same password hashes differently for another account (random salt).
    const other = email("ada2");
    await service().signUp({ email: other, password: PASSWORD });
    expect((await rowOf(other))!.passwordHash).not.toBe(row.passwordHash);
  });

  it("a second sign-up for the same email (any case) is refused without a second row", async () => {
    const address = email("dup");
    await service().signUp({ email: address, password: PASSWORD });
    await expect(
      service().signUp({ email: address.toUpperCase(), password: "another password 123" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    const rows = await handle.db
      .select()
      .from(operatorAccounts)
      .where(eq(operatorAccounts.email, address));
    expect(rows).toHaveLength(1);
  });

  it.each([
    ["a short password", { email: "short@example.com", password: "too short" }],
    ["a malformed email", { email: "not an email", password: PASSWORD }],
    ["an email with +", { email: "a+b@example.com", password: PASSWORD }],
    ["an over-long email", { email: `${"a".repeat(60)}@example.com`, password: PASSWORD }],
    ["an extra field", { email: "x@example.com", password: PASSWORD, role: "admin" }],
  ])("rejects %s with field names only and no row", async (_, body) => {
    const before = await recentAccounts();
    const err = await service()
      .signUp(body)
      .then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
    expect(err).toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(err!.message).not.toContain(PASSWORD);
    expect(await recentAccounts()).toBe(before);
  });

  it("sign-in: right password works; wrong password and unknown email fail identically", async () => {
    const address = email("bob");
    await service().signUp({ email: address, password: PASSWORD });
    expect(await service().signIn({ email: address.toUpperCase(), password: PASSWORD })).toEqual({
      operatorId: address,
    });
    expect((await rowOf(address))!.lastSignInAt).not.toBeNull();
    const wrong = await service()
      .signIn({ email: address, password: "wrong password 123" })
      .catch((e: Error & { code?: string }) => [e.code, e.message]);
    const unknown = await service()
      .signIn({ email: email("nobody"), password: PASSWORD })
      .catch((e: Error & { code?: string }) => [e.code, e.message]);
    const malformed = await service()
      .signIn({ email: "x", password: "y" })
      .catch((e: Error & { code?: string }) => [e.code, e.message]);
    expect(wrong).toEqual(["INVALID_CREDENTIALS", "the email or password is incorrect"]);
    expect(unknown).toEqual(wrong);
    expect(malformed).toEqual(wrong);
  });

  it("five failed sign-ins lock the account for 15 minutes (even the right password), then it unlocks", async () => {
    const address = email("lock");
    await service().signUp({ email: address, password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      await expect(
        service().signIn({ email: address, password: "wrong password 123" }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    const locked = (await rowOf(address))!;
    expect(locked.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    await expect(service().signIn({ email: address, password: PASSWORD })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    const [lockAudit] = await handle.db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.eventType} = 'operator.account_locked' AND ${auditEvents.actor} = ${`hr:${address}`}`,
      );
    expect(lockAudit).toBeDefined();
    await handle.db
      .update(operatorAccounts)
      .set({ lockedUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(operatorAccounts.email, address));
    expect(await service().signIn({ email: address, password: PASSWORD })).toEqual({
      operatorId: address,
    });
    expect((await rowOf(address))!).toMatchObject({ failedSignIns: 0, lockedUntil: null });
  });

  it("the daily sign-up cap holds under concurrency", async () => {
    const limited = service((await recentAccounts()) + 2);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        limited.signUp({ email: email(`cap${i}`), password: PASSWORD }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "SIGNUP_LIMIT_REACHED" });
    }
  });
});
