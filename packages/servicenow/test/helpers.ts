import { vi } from "vitest";
import type { ServiceNowConfig } from "../src/config.js";

export const PASSWORD = "S3cr3t-Pa55word!";
export const config: ServiceNowConfig = {
  instanceUrl: "https://dev00000.service-now.com",
  username: "aoo.integration",
  password: PASSWORD,
  accessRequestTable: "x_1234567_autonomo_onboarding_access_request",
  timeoutMs: 50,
  maxRetries: 2,
  retryBaseMs: 10,
};

export const SYS_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

export function record(overrides: Record<string, string> = {}) {
  return {
    sys_id: SYS_ID,
    sys_class_name: config.accessRequestTable,
    number: "OAR0001001",
    state: "1",
    short_description: "GitHub team membership",
    sys_created_on: "2026-09-23 10:00:00",
    sys_updated_on: "2026-09-23 10:00:00",
    employee_id: "HRIS-100",
    workflow_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    resource_id: "github:team:platform",
    requested_entitlement: "member",
    agent_reason: "Role requires platform repo access",
    policy_decision: "requires_approval",
    correlation_key: "wf-7c9e6679:github:team:platform",
    ...overrides,
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", ...headers },
  });

/** A fetch double that replays responses in order and records requests. */
export function fakeFetch(...responses: Array<Response | Error | "hang">) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift() ?? json({ result: [] });
    if (next === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function captureLogger() {
  const lines: Array<{ level: string; obj: object; msg: string }> = [];
  return {
    lines,
    logger: {
      debug: (obj: object, msg: string) => lines.push({ level: "debug", obj, msg }),
      warn: (obj: object, msg: string) => lines.push({ level: "warn", obj, msg }),
    },
  };
}

export const noSleep = { sleep: async () => {}, random: () => 0 };
