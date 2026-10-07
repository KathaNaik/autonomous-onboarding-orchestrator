import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/operator-accounts/password.js";

describe("(M12) operator password hashing", () => {
  it("salted scrypt: verifies the right password only, never stores it, differs per hash", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("horse");
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("a malformed or tampered stored hash never matches", async () => {
    const good = await hashPassword("correct horse battery staple");
    const parts = good.split("$");
    for (const bad of [
      "",
      "plain-text-password",
      "bcrypt$x$y",
      [...parts.slice(0, 5), "AAAA"].join("$"), // short key
      ["scrypt", "0", "8", "1", parts[4], parts[5]].join("$"), // bad cost
      ["scrypt", String(1 << 22), "8", "1", parts[4], parts[5]].join("$"), // excessive cost
      [...parts.slice(0, 4), "c2FsdA", parts[5]].join("$"), // short salt
    ]) {
      expect(await verifyPassword("correct horse battery staple", bad as string)).toBe(false);
    }
  });
});
