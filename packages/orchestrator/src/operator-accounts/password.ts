import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * (M12) Password hashing with Node's built-in scrypt (no new dependency). Stored format:
 * `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>`, so the cost can be raised later
 * without breaking existing hashes.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time check; a malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((v) => Number.isInteger(v) && v! > 0) || n! > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  const key = await derive(password, salt, n!, r!, p!);
  return timingSafeEqual(key, expected);
}

/** A real hash of a random password: verified against when the email is unknown (same timing). */
let decoy: Promise<string> | undefined;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(24).toString("base64url")));
