import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signServiceNowCallback, verifyServiceNowCallback } from "../src/index.js";

const secret = "sn-callback-secret-0123456789abcdef-xyz";
const body = JSON.stringify({ eventId: "abc:3", sysId: "a".repeat(32) });
const now = 1_790_000_000_000;
const ts = String(now);

const verify = (over: Partial<Parameters<typeof verifyServiceNowCallback>[0]> = {}) =>
  verifyServiceNowCallback({
    rawBody: body,
    timestamp: ts,
    signature: signServiceNowCallback(ts, body, secret),
    secret,
    now,
    ...over,
  });

describe("ServiceNow callback signatures", () => {
  it("matches base64 HMAC-SHA256 over '<timestamp>.<body>' (GlideCertificateEncryption.generateMac)", () => {
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("base64");
    expect(signServiceNowCallback(ts, body, secret)).toBe(`v1=${expected}`);
    expect(verify()).toEqual({ ok: true });
  });

  it.each([
    ["missing timestamp", { timestamp: undefined }, "MISSING"],
    ["missing signature", { signature: undefined }, "MISSING"],
    ["non-numeric timestamp", { timestamp: "yesterday" }, "MALFORMED"],
    ["wrong version prefix", { signature: "v2=abc" }, "MALFORMED"],
    ["truncated mac", { signature: "v1=AAAA" }, "MALFORMED"],
    [
      "wrong secret",
      { signature: signServiceNowCallback(ts, body, "another-secret-another-secret-12345") },
      "INVALID",
    ],
    ["body changed", { rawBody: body.replace("abc", "abd") }, "INVALID"],
    ["timestamp changed (replayed with a fresh clock)", { timestamp: String(now + 1) }, "INVALID"],
    ["too old", { now: now + 5 * 60_000 + 1 }, "STALE"],
    ["too far in the future", { now: now - 5 * 60_000 - 1 }, "STALE"],
  ] as const)("rejects %s", (_, over, reason) => {
    expect(verify(over as never)).toEqual({ ok: false, reason });
  });

  it("honors a custom skew window", () => {
    expect(verify({ now: now + 60_000, maxSkewMs: 30_000 })).toEqual({
      ok: false,
      reason: "STALE",
    });
  });
});
