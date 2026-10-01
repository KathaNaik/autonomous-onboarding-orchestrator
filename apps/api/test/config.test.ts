import { describe, expect, it } from "vitest";
import { isProductionDeployment, loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  HRIS_WEBHOOK_SECRET: "a-real-looking-hris-secret-0123456789abcdef",
};
const DEV_HRIS = "dev-only-hris-webhook-secret-change-me";
const DEV_ADMIN = "dev-only-onboarding-admin-token-change-me";

describe("(M10) production refuses development-only default secrets", () => {
  it("accepts the Compose defaults locally", () => {
    expect(() =>
      loadConfig({ ...base, HRIS_WEBHOOK_SECRET: DEV_HRIS, ONBOARDING_ADMIN_TOKEN: DEV_ADMIN }),
    ).not.toThrow();
  });

  it.each([
    ["AOO_ENVIRONMENT=production", { AOO_ENVIRONMENT: "production" }],
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
  ])("refuses the public HRIS default with %s, naming only the variable", (_, env) => {
    let message = "";
    try {
      loadConfig({ ...base, ...env, HRIS_WEBHOOK_SECRET: DEV_HRIS });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("HRIS_WEBHOOK_SECRET");
    expect(message).not.toContain(DEV_HRIS);
  });

  it("refuses the public operator-token default in production", () => {
    expect(() =>
      loadConfig({ ...base, AOO_ENVIRONMENT: "production", ONBOARDING_ADMIN_TOKEN: DEV_ADMIN }),
    ).toThrow(/ONBOARDING_ADMIN_TOKEN/);
  });

  it("accepts real secrets in production; preview is not production", () => {
    expect(() => loadConfig({ ...base, AOO_ENVIRONMENT: "production" })).not.toThrow();
    expect(isProductionDeployment(loadConfig({ ...base, VERCEL_ENV: "preview" }))).toBe(false);
  });
});
