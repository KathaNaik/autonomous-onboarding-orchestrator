import { createHash, timingSafeEqual } from "node:crypto";
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
) {
  const expected = digest(adminToken);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token || !timingSafeEqual(digest(token), expected)) return reject(reply);
  };
}
