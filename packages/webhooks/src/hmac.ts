import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HRIS webhook signing protocol (M10: timestamped, replay-bounded):
 *   X-AOO-Timestamp:  <milliseconds since epoch, set by the sender>
 *   X-HRIS-Signature: sha256=<lowercase hex HMAC-SHA256(secret, "<timestamp>.<raw request body>")>
 * The signature covers the exact bytes sent and the timestamp, so verify before parsing the body.
 * Requests outside the skew window are rejected; within it, a redelivery of the same event is
 * de-duplicated by the durable receipt (event id + payload hash).
 */
export const HRIS_SIGNATURE_HEADER = "x-hris-signature";
export const HRIS_TIMESTAMP_HEADER = "x-aoo-timestamp";
export const HRIS_DEFAULT_MAX_SKEW_MS = 5 * 60_000;
const PREFIX = "sha256=";

export type HrisAuthFailure = "MISSING" | "MALFORMED" | "INVALID" | "STALE";

function mac(timestamp: string, rawBody: string | Uint8Array, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
}

export function signHrisPayload(
  rawBody: string | Uint8Array,
  secret: string,
  timestamp: string,
): string {
  return PREFIX + mac(timestamp, rawBody, secret).toString("hex");
}

/** Both HRIS authentication headers for `rawBody`, stamped with `now` (default: the clock). */
export function hrisSignatureHeaders(
  rawBody: string | Uint8Array,
  secret: string,
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = String(now);
  return {
    [HRIS_TIMESTAMP_HEADER]: timestamp,
    [HRIS_SIGNATURE_HEADER]: signHrisPayload(rawBody, secret, timestamp),
  };
}

export function verifyHrisRequest(params: {
  rawBody: string | Uint8Array;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  now?: number;
  maxSkewMs?: number;
}): { ok: true } | { ok: false; reason: HrisAuthFailure } {
  const { timestamp, signature } = params;
  if (!timestamp || !signature) return { ok: false, reason: "MISSING" };
  if (!/^\d{10,16}$/.test(timestamp) || !signature.startsWith(PREFIX)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const provided = signature.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: "MALFORMED" };

  // Authenticity before freshness: a forged request never learns the clock-skew rule.
  if (
    !timingSafeEqual(Buffer.from(provided, "hex"), mac(timestamp, params.rawBody, params.secret))
  ) {
    return { ok: false, reason: "INVALID" };
  }
  const skew = Math.abs((params.now ?? Date.now()) - Number(timestamp));
  if (skew > (params.maxSkewMs ?? HRIS_DEFAULT_MAX_SKEW_MS)) return { ok: false, reason: "STALE" };
  return { ok: true };
}
