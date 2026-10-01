import { auditEvents, operatorSessionRevocations, type Database } from "@aoo/db";
import { and, eq, gt, sql } from "drizzle-orm";

export interface OperatorSessionService {
  /** Records a logged-out session; idempotent. Audited as `operator.session_revoked`. */
  revoke(input: { sessionNonce: string; operatorId: string; expiresAt: Date }): Promise<void>;
  /** True while the session is revoked and not yet expired anyway. */
  isRevoked(sessionNonce: string): Promise<boolean>;
}

/**
 * (M10) Server-side logout for the stateless operator session cookie: a revoked nonce is refused
 * by every operator API route until the session would have expired on its own.
 */
export function createOperatorSessionService(db: Database): OperatorSessionService {
  return {
    async revoke({ sessionNonce, operatorId, expiresAt }) {
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(operatorSessionRevocations)
          .values({ sessionNonce, operatorId, expiresAt })
          .onConflictDoNothing()
          .returning({ nonce: operatorSessionRevocations.sessionNonce });
        if (inserted.length === 0) return;
        await tx
          .insert(auditEvents)
          .values({
            workflowId: null,
            eventType: "operator.session_revoked",
            actor: `hr:${operatorId}`,
            payload: { reason: "LOGOUT" },
            idempotencyKey: `operator-session-revoked:${sessionNonce}`,
          })
          .onConflictDoNothing();
      });
    },
    async isRevoked(sessionNonce) {
      const rows = await db
        .select({ nonce: operatorSessionRevocations.sessionNonce })
        .from(operatorSessionRevocations)
        .where(
          and(
            eq(operatorSessionRevocations.sessionNonce, sessionNonce),
            gt(operatorSessionRevocations.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}
