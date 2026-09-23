import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signHrisPayload, verifyHrisSignature } from "../src/index.js";

const secret = "test-secret-with-at-least-32-characters!";
const body = JSON.stringify({ eventId: "evt-1", hello: "world" });

describe("HRIS HMAC signatures", () => {
  it("signs as sha256=<hex HMAC-SHA256 of the raw body>", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    expect(signHrisPayload(body, secret)).toBe(`sha256=${hex}`);
  });

  it("verifies its own signature over string and byte bodies", () => {
    const sig = signHrisPayload(body, secret);
    expect(verifyHrisSignature(body, sig, secret)).toBe(true);
    expect(verifyHrisSignature(Buffer.from(body), sig, secret)).toBe(true);
    expect(verifyHrisSignature(body, sig.toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(
      true,
    );
  });

  it.each([
    ["missing header", undefined],
    ["empty header", ""],
    ["no prefix", signHrisPayload(body, secret).slice("sha256=".length)],
    ["wrong algorithm prefix", signHrisPayload(body, secret).replace("sha256=", "sha1=")],
    ["truncated digest", signHrisPayload(body, secret).slice(0, -2)],
    ["non-hex digest", `sha256=${"z".repeat(64)}`],
    ["wrong secret", signHrisPayload(body, "another-secret-with-at-least-32-chars")],
  ])("rejects %s", (_, header) => {
    expect(verifyHrisSignature(body, header, secret)).toBe(false);
  });

  it("rejects a body that differs by a single byte", () => {
    const sig = signHrisPayload(body, secret);
    expect(verifyHrisSignature(body.replace("world", "World"), sig, secret)).toBe(false);
    expect(verifyHrisSignature(`${body} `, sig, secret)).toBe(false);
  });
});
