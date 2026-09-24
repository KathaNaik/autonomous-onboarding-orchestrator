import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ServiceNow → backend approval-callback protocol (M4C):
 *   X-AOO-Timestamp: <milliseconds since epoch, set by the sender>
 *   X-AOO-Signature: v1=<base64 HMAC-SHA256(secret, "<timestamp>.<raw request body>")>
 * Base64 matches ServiceNow's GlideCertificateEncryption.generateMac output. The timestamp is
 * inside the MAC, so it cannot be altered; requests outside the skew window are rejected
 * (replay protection together with durable event-id deduplication).
 */
export const SN_CALLBACK_TIMESTAMP_HEADER = "x-aoo-timestamp";
export const SN_CALLBACK_SIGNATURE_HEADER = "x-aoo-signature";
const VERSION = "v1=";

export type CallbackAuthFailure = "MISSING" | "MALFORMED" | "STALE" | "INVALID";

export function signServiceNowCallback(
  timestamp: string,
  rawBody: string | Uint8Array,
  secret: string,
): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("base64");
  return `${VERSION}${mac}`;
}

export function verifyServiceNowCallback(params: {
  rawBody: string | Uint8Array;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  now?: number;
  maxSkewMs?: number;
}): { ok: true } | { ok: false; reason: CallbackAuthFailure } {
  const { timestamp, signature } = params;
  if (!timestamp || !signature) return { ok: false, reason: "MISSING" };
  if (!/^\d{10,16}$/.test(timestamp) || !signature.startsWith(VERSION)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const provided = Buffer.from(signature.slice(VERSION.length), "base64");
  if (provided.length !== 32) return { ok: false, reason: "MALFORMED" };

  const expected = createHmac("sha256", params.secret)
    .update(`${timestamp}.`)
    .update(params.rawBody)
    .digest();
  // Check authenticity before freshness, so a forged request never learns the clock skew rule.
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "INVALID" };

  const skew = Math.abs((params.now ?? Date.now()) - Number(timestamp));
  if (skew > (params.maxSkewMs ?? 5 * 60_000)) return { ok: false, reason: "STALE" };
  return { ok: true };
}
