import { auditEvents, operatorAccounts, type Database } from "@aoo/db";
import { OperatorCredentialsSchema } from "@aoo/shared";
import { eq, sql } from "drizzle-orm";
import { decoyHash, hashPassword, verifyPassword } from "./password.js";

export type OperatorAccountErrorCode =
  "INVALID_PAYLOAD" | "ACCOUNT_UNAVAILABLE" | "INVALID_CREDENTIALS" | "SIGNUP_LIMIT_REACHED";

export class OperatorAccountError extends Error {
  constructor(
    readonly code: OperatorAccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperatorAccountError";
  }
}

export interface OperatorAccountService {
  /** Creates an account (the lower-cased email becomes the operator id). Audited. */
  signUp(input: unknown): Promise<{ operatorId: string }>;
  /** Checks a password; wrong email, wrong password and a locked account fail identically. */
  signIn(input: unknown): Promise<{ operatorId: string }>;
}

export interface OperatorAccountOptions {
  /** New accounts allowed in any rolling 24 hours (across everyone). */
  signupDailyLimit: number;
  /** Consecutive failed sign-ins that lock the account. */
  maxFailedSignIns?: number;
  /** How long a locked account refuses sign-in. */
  lockMinutes?: number;
}

const INVALID = () =>
  new OperatorAccountError("INVALID_CREDENTIALS", "the email or password is incorrect");

/**
 * (M12) Self-registered operator accounts (user decision: a proof of concept for a selected
 * audience; every account is a full operator). Only a salted scrypt hash is stored; passwords and
 * hashes never reach logs, audit payloads or responses.
 */
export function createOperatorAccountService(
  db: Database,
  options: OperatorAccountOptions,
): OperatorAccountService {
  const maxFailed = options.maxFailedSignIns ?? 5;
  const lockMinutes = options.lockMinutes ?? 15;

  return {
    async signUp(input) {
      const parsed = OperatorCredentialsSchema.safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        throw new OperatorAccountError("INVALID_PAYLOAD", `invalid fields: ${fields.join(", ")}`);
      }
      const { email, password } = parsed.data;
      const passwordHash = await hashPassword(password); // outside the transaction (CPU-bound)
      return db.transaction(async (tx) => {
        // Serialize sign-ups so the daily cap holds under concurrency.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operator-accounts:signup'))`);
        const { rows } = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM operator_accounts
          WHERE created_at > clock_timestamp() - interval '24 hours'`);
        if ((rows[0]?.n ?? 0) >= options.signupDailyLimit) {
          throw new OperatorAccountError(
            "SIGNUP_LIMIT_REACHED",
            "no more accounts can be created today",
          );
        }
        const inserted = await tx
          .insert(operatorAccounts)
          .values({ email, passwordHash })
          .onConflictDoNothing({ target: operatorAccounts.email })
          .returning({ id: operatorAccounts.id });
        if (inserted.length === 0) {
          throw new OperatorAccountError(
            "ACCOUNT_UNAVAILABLE",
            "an account can't be created for this email",
          );
        }
        await tx.insert(auditEvents).values({
          workflowId: null,
          eventType: "operator.account_created",
          actor: `hr:${email}`,
          payload: { accountId: inserted[0]!.id },
        });
        return { operatorId: email };
      });
    },

    async signIn(input) {
      const parsed = OperatorCredentialsSchema.safeParse(input);
      if (!parsed.success) {
        await verifyPassword("x".repeat(12), await decoyHash()); // same timing as a real check
        throw INVALID();
      }
      const { email, password } = parsed.data;
      const [row] = await db
        .select({
          id: operatorAccounts.id,
          passwordHash: operatorAccounts.passwordHash,
          locked: sql<boolean>`coalesce(${operatorAccounts.lockedUntil} > clock_timestamp(), false)`,
        })
        .from(operatorAccounts)
        .where(eq(operatorAccounts.email, email));
      if (!row || row.locked) {
        await verifyPassword(password, await decoyHash());
        throw INVALID();
      }
      if (!(await verifyPassword(password, row.passwordHash))) {
        const [updated] = await db
          .update(operatorAccounts)
          .set({
            failedSignIns: sql`CASE WHEN ${operatorAccounts.failedSignIns} + 1 >= ${maxFailed}
              THEN 0 ELSE ${operatorAccounts.failedSignIns} + 1 END`,
            lockedUntil: sql`CASE WHEN ${operatorAccounts.failedSignIns} + 1 >= ${maxFailed}
              THEN clock_timestamp() + make_interval(mins => ${lockMinutes})
              ELSE ${operatorAccounts.lockedUntil} END`,
          })
          .where(eq(operatorAccounts.id, row.id))
          .returning({ lockedUntil: operatorAccounts.lockedUntil });
        if (updated?.lockedUntil && updated.lockedUntil.getTime() > Date.now()) {
          await db.insert(auditEvents).values({
            workflowId: null,
            eventType: "operator.account_locked",
            actor: `hr:${email}`,
            payload: { accountId: row.id, lockMinutes },
          });
        }
        throw INVALID();
      }
      await db
        .update(operatorAccounts)
        .set({ failedSignIns: 0, lockedUntil: null, lastSignInAt: sql`clock_timestamp()` })
        .where(eq(operatorAccounts.id, row.id));
      return { operatorId: email };
    },
  };
}
