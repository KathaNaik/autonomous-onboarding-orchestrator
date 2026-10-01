import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("(M10) security headers", () => {
  it("keep a real Origin on same-site form posts (login/logout CSRF check)", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    const get = (k: string) => all.find((h) => h.key === k)?.value;
    // no-referrer would make browsers send `Origin: null` on same-site POSTs → login 403.
    expect(get("Referrer-Policy")).toBe("same-origin");
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const admin = rules.find((r) => r.source === "/admin/:path*")!.headers;
    expect(admin).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
