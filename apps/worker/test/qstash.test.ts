import { describe, expect, it } from "vitest";
import { createQStashVerifier } from "../src/qstash.js";
import { SCHEDULE_BODY, WORKER_URL, signQStash, testSigningKeys } from "./qstash-signing.js";

const keys = testSigningKeys();
const verifier = createQStashVerifier({
  currentSigningKey: keys.current,
  nextSigningKey: keys.next,
  url: WORKER_URL,
});
const sign = (overrides: Partial<Parameters<typeof signQStash>[0]> = {}) =>
  signQStash({ key: keys.current, url: WORKER_URL, body: SCHEDULE_BODY, ...overrides });
const verify = (signature: string | undefined, body = SCHEDULE_BODY) =>
  verifier.verify({ signature, body });

describe("(M10) QStash signature verification (official Receiver)", () => {
  it("accepts a valid delivery signed with the current key", async () => {
    expect(await verify(sign())).toBe(true);
  });

  it("accepts a delivery signed with the next key (key rotation)", async () => {
    expect(await verify(sign({ key: keys.next }))).toBe(true);
  });

  it.each([
    ["no signature", () => undefined],
    ["an empty signature", () => ""],
    ["a malformed signature", () => "not-a-jwt"],
    ["a truncated JWT", () => sign().slice(0, -5)],
    ["a wrong signing key", () => sign({ key: testSigningKeys().current })],
    ["an expired signature", () => sign({ now: Date.now() - 600_000, expiresInSeconds: 60 })],
    ["a not-yet-valid signature", () => sign({ notBeforeOffsetSeconds: 600 })],
    ["another destination URL", () => sign({ url: "https://evil.test/api/worker/run" })],
    ["another issuer", () => sign({ issuer: "Someone" })],
    ["an oversized header", () => "x".repeat(10_000)],
  ])("rejects %s", async (_, signature) => {
    expect(await verify(signature())).toBe(false);
  });

  it("rejects a valid signature presented with a changed raw body", async () => {
    const signature = sign();
    expect(await verify(signature, JSON.stringify({ source: "qstash-schedule", x: 1 }))).toBe(
      false,
    );
    // Re-serialized JSON (different whitespace) is a different raw body.
    expect(await verify(signature, JSON.stringify(JSON.parse(SCHEDULE_BODY), null, 1))).toBe(false);
  });

  it("rejects an unsigned (alg none) token", async () => {
    const [h, p] = sign().split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    expect(h).toBeTruthy();
    expect(await verify(none)).toBe(false);
  });

  it("never falls back to QStash development keys (QSTASH_DEV in the environment)", async () => {
    process.env.QSTASH_DEV = "true";
    try {
      expect(await verify(sign())).toBe(true);
      expect(await verify(sign({ key: "development-key-that-is-not-ours-123" }))).toBe(false);
    } finally {
      delete process.env.QSTASH_DEV;
    }
  });
});
