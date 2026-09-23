import { signHrisPayload, HRIS_SIGNATURE_HEADER } from "@aoo/webhooks";
import { loadConfig, type Config } from "../src/config.js";

export const TEST_SECRET = "test-hris-secret-0123456789abcdef-0123";

/** Config for tests. The DB URL is never contacted unless a test sends a valid event. */
export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    HRIS_WEBHOOK_SECRET: TEST_SECRET,
    ...overrides,
  });
}

let seq = 0;
export function offerSignedEvent(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const id = `${Date.now().toString(36)}-${process.pid}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    eventId: `evt-${id}`,
    eventType: "offer.signed",
    occurredAt: new Date().toISOString(),
    employeeId: `HRIS-${id}`,
    employee: { firstName: "Grace", lastName: "Hopper", email: `grace.${id}@example.com` },
    role: "Software Engineer",
    department: "Engineering",
    managerId: "HRIS-MGR-1",
    offerStatus: "SIGNED",
    candidateStatus: "CLEARED",
    ...overrides,
  };
}

/** Headers + body exactly as the HRIS simulator sends them. */
export function signedRequest(payload: unknown, secret = TEST_SECRET) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    body,
    headers: {
      "content-type": "application/json",
      [HRIS_SIGNATURE_HEADER]: signHrisPayload(body, secret),
    },
  };
}
