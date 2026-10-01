import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

/**
 * Test-only QStash signer: produces the Upstash-Signature JWT format (HS256, issuer "Upstash",
 * subject = destination URL, body = base64url SHA-256 of the raw body, exp/nbf). Keys are random
 * per test run; no real signing key is ever used in tests.
 */
export const testSigningKeys = () => ({
  current: `sig_test_current_${randomBytes(16).toString("hex")}`,
  next: `sig_test_next_${randomBytes(16).toString("hex")}`,
});

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function signQStash(options: {
  key: string;
  url: string;
  body: string;
  now?: number;
  expiresInSeconds?: number;
  notBeforeOffsetSeconds?: number;
  issuer?: string;
  alg?: string;
}): string {
  const sec = Math.floor((options.now ?? Date.now()) / 1000);
  const header = b64url(JSON.stringify({ alg: options.alg ?? "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: options.issuer ?? "Upstash",
      sub: options.url,
      exp: sec + (options.expiresInSeconds ?? 300),
      nbf: sec + (options.notBeforeOffsetSeconds ?? 0),
      iat: sec,
      jti: `jwt_${randomUUID()}`,
      body: createHash("sha256").update(options.body).digest("base64url"),
    }),
  );
  const signature = createHmac("sha256", options.key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export const SCHEDULE_BODY = JSON.stringify({ source: "qstash-schedule" });
export const WORKER_URL = "https://aoo-worker.test/api/worker/run";
