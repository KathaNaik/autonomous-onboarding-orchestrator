import { createDatabase, type DatabaseHandle } from "@aoo/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const server = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
const PASSWORD = "correct horse battery staple";
const lines: string[] = [];
let app: FastifyInstance;
let handle: DatabaseHandle;

beforeAll(async () => {
  handle = createDatabase(inject("databaseUrl"));
  app = await buildApp(
    testConfig({
      DATABASE_URL: inject("databaseUrl"),
      ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN,
      LOG_LEVEL: "info",
    }),
    {},
    { logStream: { write: (line) => void lines.push(line) } },
  );
});
afterAll(async () => {
  await app.close();
  await handle.close();
});
beforeEach(() => {
  lines.length = 0;
});

const email = () => `op.${Math.random().toString(36).slice(2, 8)}@example.com`;
const post = (url: string, payload: unknown, headers: Record<string, string> = server) =>
  app.inject({ method: "POST", url, headers, payload: payload as never });
const accounts = async () =>
  (await handle.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM operator_accounts`))
    .rows[0]!.n;

describe("(M12) operator accounts API", () => {
  it("sign-up then sign-in; the password never appears in responses or logs", async () => {
    const address = email();
    const created = await post("/admin/operator-accounts", { email: address, password: PASSWORD });
    expect([created.statusCode, created.json()]).toEqual([201, { operatorId: address }]);
    const signedIn = await post("/admin/operator-accounts/sign-in", {
      email: address,
      password: PASSWORD,
    });
    expect([signedIn.statusCode, signedIn.json()]).toEqual([200, { operatorId: address }]);
    const wrong = await post("/admin/operator-accounts/sign-in", {
      email: address,
      password: "wrong password 123",
    });
    expect([wrong.statusCode, wrong.json().error]).toEqual([401, "INVALID_CREDENTIALS"]);
    const dup = await post("/admin/operator-accounts", { email: address, password: PASSWORD });
    expect([dup.statusCode, dup.json().error]).toEqual([409, "ACCOUNT_UNAVAILABLE"]);
    const bad = await post("/admin/operator-accounts", { email: address, password: "short" });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    const everything =
      lines.join("\n") + [created, signedIn, wrong, dup, bad].map((r) => r.body).join("\n");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('short"');
    expect(everything).not.toMatch(/scrypt\$/);
    expect(everything).not.toContain(ADMIN_TOKEN);
  });

  it("both routes need the server-only bearer token; refused before any read or write", async () => {
    const before = await accounts();
    for (const headers of [
      { "content-type": "application/json" },
      { ...server, authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" },
    ]) {
      const create = await post(
        "/admin/operator-accounts",
        { email: email(), password: PASSWORD },
        headers,
      );
      const signIn = await post(
        "/admin/operator-accounts/sign-in",
        { email: "x@example.com", password: PASSWORD },
        headers,
      );
      expect([create.statusCode, signIn.statusCode]).toEqual([401, 401]);
    }
    const text = await post("/admin/operator-accounts", "email=x", {
      authorization: server.authorization,
      "content-type": "text/plain",
    });
    expect([text.statusCode, text.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    expect(await accounts()).toBe(before);
  });

  it("the shared token is not a password: it signs no one in", async () => {
    const res = await post("/admin/operator-accounts/sign-in", {
      email: "ops.alice@example.com",
      password: ADMIN_TOKEN,
    });
    expect([res.statusCode, res.json().error]).toEqual([401, "INVALID_CREDENTIALS"]);
  });

  it("the daily sign-up cap answers 429", async () => {
    const { rows } = await handle.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM operator_accounts
      WHERE created_at > clock_timestamp() - interval '24 hours'`);
    const capped = await buildApp(
      testConfig({
        DATABASE_URL: inject("databaseUrl"),
        ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN,
        OPERATOR_SIGNUP_DAILY_LIMIT: String(rows[0]!.n),
      }),
    );
    const res = await capped.inject({
      method: "POST",
      url: "/admin/operator-accounts",
      headers: server,
      payload: { email: email(), password: PASSWORD },
    });
    expect([res.statusCode, res.json().error]).toEqual([429, "SIGNUP_LIMIT_REACHED"]);
    await capped.close();
  });
});
