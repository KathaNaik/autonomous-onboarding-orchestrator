import {
  SN_CALLBACK_SIGNATURE_HEADER,
  SN_CALLBACK_TIMESTAMP_HEADER,
  signServiceNowCallback,
} from "@aoo/webhooks";

export const CALLBACK_SECRET = "sn-callback-secret-for-tests-0123456789";
export const CALLBACK_INSTANCE = "dev000001";
export const CALLBACK_TABLE = "x_0000000_autonomo_onboarding_access_request";

export const callbackEnv = {
  SERVICENOW_CALLBACK_SECRET: CALLBACK_SECRET,
  SERVICENOW_CALLBACK_INSTANCE: CALLBACK_INSTANCE,
  SERVICENOW_CALLBACK_TABLE: CALLBACK_TABLE,
};

export function callbackPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `${"a".repeat(32)}:${Math.floor(Math.random() * 1e9)}`,
    instance: CALLBACK_INSTANCE,
    table: CALLBACK_TABLE,
    sysId: "a".repeat(32),
    number: "OAR0001234",
    correlationKey: "aoo-test-oar-0123456789abcdef0123456789abcdef01234567",
    claimedApprovalState: "approved",
    ...overrides,
  };
}

/** Signs exactly like the ServiceNow business rule (HMAC over "<ts>.<body>", base64). */
export function signedCallback(
  payload: unknown,
  opts: { secret?: string; timestamp?: number } = {},
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = String(opts.timestamp ?? Date.now());
  return {
    body,
    headers: {
      "content-type": "application/json",
      [SN_CALLBACK_TIMESTAMP_HEADER]: ts,
      [SN_CALLBACK_SIGNATURE_HEADER]: signServiceNowCallback(
        ts,
        body,
        opts.secret ?? CALLBACK_SECRET,
      ),
    },
  };
}
