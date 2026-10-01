import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HRIS_SIGNATURE_HEADER,
  HRIS_TIMESTAMP_HEADER,
  hrisSignatureHeaders,
  signHrisPayload,
  verifyHrisRequest,
} from "../src/index.js";

const secret = "test-secret-with-at-least-32-characters!";
const body = JSON.stringify({ eventId: "evt-1", hello: "world" });
const now = 1_790_000_000_000;
const ts = String(now);

const verify = (overrides: Partial<Parameters<typeof verifyHrisRequest>[0]> = {}) =>
  verifyHrisRequest({
    rawBody: body,
    timestamp: ts,
    signature: signHrisPayload(body, secret, ts),
    secret,
    now,
    ...overrides,
  });

describe("HRIS HMAC signatures (timestamped)", () => {
  it('signs as sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">', () => {
    const hex = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(signHrisPayload(body, secret, ts)).toBe(`sha256=${hex}`);
  });

  it("builds both headers with the given clock", () => {
    const headers = hrisSignatureHeaders(body, secret, now);
    expect(headers[HRIS_TIMESTAMP_HEADER]).toBe(ts);
    expect(headers[HRIS_SIGNATURE_HEADER]).toBe(signHrisPayload(body, secret, ts));
  });

  it("verifies its own signature over string and byte bodies", () => {
    expect(verify()).toEqual({ ok: true });
    expect(verify({ rawBody: Buffer.from(body) })).toEqual({ ok: true });
  });

  it.each([
    ["missing signature", { signature: undefined }, "MISSING"],
    ["missing timestamp", { timestamp: undefined }, "MISSING"],
    ["non-numeric timestamp", { timestamp: "yesterday" }, "MALFORMED"],
    ["no prefix", { signature: signHrisPayload(body, secret, ts).slice(7) }, "MALFORMED"],
    [
      "truncated digest",
      { signature: signHrisPayload(body, secret, ts).slice(0, -2) },
      "MALFORMED",
    ],
    ["non-hex digest", { signature: `sha256=${"z".repeat(64)}` }, "MALFORMED"],
    [
      "wrong secret",
      { signature: signHrisPayload(body, "another-secret-with-at-least-32-chars", ts) },
      "INVALID",
    ],
    [
      "legacy body-only signature",
      { signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
      "INVALID",
    ],
    ["timestamp altered after signing", { timestamp: String(now + 1) }, "INVALID"],
    ["body altered after signing", { rawBody: body.replace("world", "World") }, "INVALID"],
  ] as const)("rejects %s", (_, overrides, reason) => {
    expect(verify(overrides)).toEqual({ ok: false, reason });
  });

  it("rejects a valid signature outside the skew window (past and future)", () => {
    expect(verify({ now: now + 300_001 })).toEqual({ ok: false, reason: "STALE" });
    expect(verify({ now: now - 300_001 })).toEqual({ ok: false, reason: "STALE" });
    expect(verify({ now: now + 300_000 })).toEqual({ ok: true });
    expect(verify({ now: now + 61_000, maxSkewMs: 60_000 })).toEqual({
      ok: false,
      reason: "STALE",
    });
  });

  it("checks authenticity before freshness (a forged stale request is INVALID)", () => {
    expect(verify({ signature: signHrisPayload(body, `${secret}x`, ts), now: now + 10e6 })).toEqual(
      {
        ok: false,
        reason: "INVALID",
      },
    );
  });
});
