import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * (M9) Server-only operator dashboard sessions. The browser only ever holds a short-lived,
 * HttpOnly cookie with a signed payload `{ v, op, iat, exp, n }`: operator id, times and a nonce.
 * Never the admin token. The signing key is derived from the existing ONBOARDING_ADMIN_TOKEN with
 * a fixed domain-separation label (no new secret; rotating the token invalidates every session).
 */
export const SESSION_COOKIE = "aoo_operator_session";
/** Every dashboard page and its login/logout handlers live under this path. */
export const SESSION_PATH = "/admin/onboarding";
export const SESSION_TTL_SECONDS = 30 * 60;
const KEY_LABEL = "aoo.web.operator-session.v1";
const MAX_COOKIE = 512;

/** Same rule as the API's operator id (audit actor `hr:<id>`). */
export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

const PayloadSchema = z.strictObject({
  v: z.literal(1),
  op: z.string().regex(OPERATOR_ID_PATTERN),
  iat: z.number().int(),
  exp: z.number().int(),
  n: z.string().regex(/^[0-9a-f-]{36}$/),
});
export type OperatorSession = {
  operatorId: string;
  issuedAt: number;
  expiresAt: number;
  /** (M10) Per-session id: sent to the API, which refuses it after logout (revocation). */
  nonce: string;
};

const signingKey = (adminToken: string) =>
  createHmac("sha256", adminToken).update(KEY_LABEL).digest();
const sign = (adminToken: string, body: string) =>
  createHmac("sha256", signingKey(adminToken)).update(body).digest("base64url");

/** A signed session cookie value for this operator (seconds since epoch). */
export function createSessionValue(
  operatorId: string,
  adminToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = PayloadSchema.parse({
    v: 1,
    op: operatorId,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    n: randomUUID(),
  });
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(adminToken, body)}`;
}

/** Verifies signature, shape and expiry; null for anything missing, tampered or expired. */
export function verifySessionValue(
  value: string | undefined | null,
  adminToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): OperatorSession | null {
  if (!value || value.length > MAX_COOKIE) return null;
  const [body, mac, extra] = value.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(adminToken, body));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed;
  try {
    parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString()));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.exp <= nowSeconds || p.iat > nowSeconds + 60 || p.exp - p.iat > SESSION_TTL_SECONDS)
    return null;
  return { operatorId: p.op, issuedAt: p.iat, expiresAt: p.exp, nonce: p.n };
}

/** Set-Cookie attributes: HttpOnly, SameSite=Strict, path-restricted, short-lived; Secure on https. */
export function sessionCookieHeader(value: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    `Path=${SESSION_PATH}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    `Path=${SESSION_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Secure cookies whenever the request reached us over https (directly or via a proxy), and
 * (M10) always in production deployments.
 */
export function useSecureCookies(request: Request, production: boolean): boolean {
  return production || isSecureRequest(request);
}

/** Secure cookies whenever the request reached us over https (directly or via a proxy). */
export function isSecureRequest(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
  );
}

/**
 * Cross-site form-post guard: a browser's Origin header must name this site's host (the Host /
 * X-Forwarded-Host the request arrived on; inside a container `request.url` may carry an internal
 * host). A missing Origin (non-browser client) is allowed; the session itself still decides.
 */
export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;
  return originHost === host;
}
