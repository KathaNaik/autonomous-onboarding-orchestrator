import { createHash, timingSafeEqual } from "node:crypto";
import { OPERATOR_SESSION_HEADER } from "@aoo/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/** The operator's self-declared id, recorded as the audit actor `hr:<id>`. */
export const OPERATOR_ID_HEADER = "x-operator-id";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * HR/onboarding operator authorization (M7B, reused by M7C): `Authorization: Bearer
 * <ONBOARDING_ADMIN_TOKEN>`, compared in constant time. Use as an `onRequest` hook so it runs
 * before body parsing and any database access. Employee-facing credentials are never accepted.
 */
export function operatorAuthorizer(
  adminToken: string,
  reject: (reply: FastifyReply) => FastifyReply,
  sessions?: OperatorSessionCheck,
) {
  const expected = digest(adminToken);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token || !timingSafeEqual(digest(token), expected)) return reject(reply);
    // (M10) Calls made on behalf of a dashboard session carry its nonce: a logged-out (revoked)
    // session is refused like a bad token, before any route reads or writes.
    const session = request.headers[OPERATOR_SESSION_HEADER];
    if (session === undefined) return;
    if (typeof session !== "string" || !UUID.test(session)) return reject(reply);
    if (sessions && (await sessions.isRevoked(session))) return reject(reply);
  };
}

/** (M10) What the authorizer needs to refuse revoked dashboard sessions. */
export interface OperatorSessionCheck {
  isRevoked(sessionNonce: string): Promise<boolean>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
