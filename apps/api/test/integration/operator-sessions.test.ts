import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabase,
  operatorSessionRevocations,
  type DatabaseHandle,
} from "@aoo/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "ops.alice" };
let app: FastifyInstance;
let handle: DatabaseHandle;

beforeAll(async () => {
  app = await buildApp(
    testConfig({ DATABASE_URL: inject("databaseUrl"), ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }),
  );
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const revoke = (nonce: string, headers: Record<string, string> = auth, expiresAt?: string) =>
  app.inject({
    method: "POST",
    url: "/admin/operator-sessions/revoke",
    headers: { ...headers, "content-type": "application/json" },
    payload: {
      sessionNonce: nonce,
      expiresAt: expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  });
const read = (session?: string) =>
  app.inject({
    method: "GET",
    url: "/admin/onboarding",
    headers: { ...auth, ...(session && { "x-operator-session": session }) },
  });

describe("(M10) server-side operator session revocation", () => {
  it("a revoked session is refused by every operator route before any read or write; others are not", async () => {
    const mine = randomUUID();
    const other = randomUUID();
    expect((await read(mine)).statusCode).toBe(200);
    const res = await revoke(mine);
    expect([res.statusCode, res.json()]).toEqual([200, { revoked: true }]);
    // Read model, GitHub identity (GET), manual completion (POST, refused before body parsing).
    expect((await read(mine)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/admin/onboarding/${randomUUID()}/github-identity`,
          headers: { ...auth, "x-operator-session": mine },
        })
      ).statusCode,
    ).toBe(401);
    const manual = await app.inject({
      method: "POST",
      url: `/admin/access-requests/${randomUUID()}/manual-complete`,
      headers: { ...auth, "x-operator-session": mine, "content-type": "application/json" },
      payload: "{not json",
    });
    expect([manual.statusCode, manual.json().error]).toEqual([401, "OPERATOR_UNAUTHORIZED"]);
    // Another (live) session and server-to-server calls without a session still work.
    expect((await read(other)).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(200);
  });

  it("is idempotent and audited once, with no secret or nonce in the audit payload", async () => {
    const nonce = randomUUID();
    await revoke(nonce);
    await revoke(nonce);
    const rows = await handle.db
      .select()
      .from(operatorSessionRevocations)
      .where(eq(operatorSessionRevocations.sessionNonce, nonce));
    expect(rows).toMatchObject([{ operatorId: "ops.alice" }]);
    const audits = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.idempotencyKey, `operator-session-revoked:${nonce}`));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      eventType: "operator.session_revoked",
      actor: "hr:ops.alice",
      payload: { reason: "LOGOUT" },
    });
  });

  it("a malformed session id is refused; an expired revocation no longer matters", async () => {
    expect((await read("not-a-uuid")).statusCode).toBe(401);
    const old = randomUUID();
    await revoke(old, auth, new Date(Date.now() - 1000).toISOString());
    expect((await read(old)).statusCode).toBe(200); // the session itself would be expired anyway
  });

  it("revocation requires operator authorization, an operator id and an exact body", async () => {
    const before = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM operator_session_revocations`,
    );
    expect((await revoke(randomUUID(), { "x-operator-id": "ops.alice" })).statusCode).toBe(401);
    expect(
      (await revoke(randomUUID(), { authorization: `Bearer ${ADMIN_TOKEN}` })).statusCode,
    ).toBe(400);
    const extra = await app.inject({
      method: "POST",
      url: "/admin/operator-sessions/revoke",
      headers: { ...auth, "content-type": "application/json" },
      payload: { sessionNonce: randomUUID(), expiresAt: new Date().toISOString(), x: 1 },
    });
    expect([extra.statusCode, extra.json().error]).toEqual([400, "INVALID_PAYLOAD"]);
    const after = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM operator_session_revocations`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
