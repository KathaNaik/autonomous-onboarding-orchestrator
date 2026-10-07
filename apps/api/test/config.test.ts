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

describe("(M11) offer-letter intake configuration", () => {
  it("is off by default and needs OPENAI_API_KEY when enabled (names the variable only)", () => {
    expect(loadConfig(base).offerLetterAgent).toBeUndefined();
    expect(() => loadConfig({ ...base, OFFER_LETTER_INTAKE_ENABLED: "true" })).toThrow(
      /OPENAI_API_KEY/,
    );
    const on = loadConfig({
      ...base,
      OFFER_LETTER_INTAKE_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-value-not-real-000000000000",
    });
    expect(on.offerLetterAgent).toMatchObject({
      OFFER_LETTER_AGENT_TIMEOUT_MS: 40_000,
      OFFER_LETTER_AGENT_MAX_ATTEMPTS: 1,
    });
  });
});

describe("(M12) usage caps", () => {
  it("default to 20 sign-ups, 3 uploads per operator and 30 uploads overall per day", () => {
    const c = loadConfig(base);
    expect([
      c.OPERATOR_SIGNUP_DAILY_LIMIT,
      c.OFFER_LETTER_DAILY_LIMIT_PER_OPERATOR,
      c.OFFER_LETTER_DAILY_LIMIT_TOTAL,
    ]).toEqual([20, 3, 30]);
    expect(
      loadConfig({ ...base, OFFER_LETTER_DAILY_LIMIT_PER_OPERATOR: "5" })
        .OFFER_LETTER_DAILY_LIMIT_PER_OPERATOR,
    ).toBe(5);
    expect(() => loadConfig({ ...base, OPERATOR_SIGNUP_DAILY_LIMIT: "-1" })).toThrow();
  });
});
