import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HRIS webhook signing protocol:
 *   X-HRIS-Signature: sha256=<lowercase hex HMAC-SHA256(secret, raw request body)>
 * The signature covers the exact bytes sent, so verify before parsing the body.
 */
export const HRIS_SIGNATURE_HEADER = "x-hris-signature";
const PREFIX = "sha256=";

export function signHrisPayload(rawBody: string | Uint8Array, secret: string): string {
  return PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyHrisSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(PREFIX)) return false;
  const provided = signatureHeader.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(provided, "hex"), expected);
}
