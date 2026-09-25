import type { OktaConfig } from "./config.js";
import { OktaError } from "./errors.js";
import { redactOktaText } from "./redact.js";
import {
  OKTA_GROUP_ID,
  OKTA_USER_ID,
  OktaGroupSchema,
  OktaNewUserSchema,
  OktaUserSchema,
  type OktaGroup,
  type OktaNewUser,
  type OktaUser,
} from "./schemas.js";

export interface OktaClientLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface OktaCallOptions {
  /** Deadline for the whole call, including retries. */
  signal?: AbortSignal;
}

/**
 * Narrow, additive Okta operations for M7A. There is deliberately no generic request method,
 * no delete/deactivate, no group removal, no password or admin-role operations.
 */
export interface OktaClient {
  /** Credential check for the read-only preflight: true when the API token is accepted. */
  verifyCredentials(options?: OktaCallOptions): Promise<true>;
  getUser(userId: string, options?: OktaCallOptions): Promise<OktaUser | null>;
  /**
   * Exact-identity lookup: the user whose login equals `login` (strongly consistent) plus any
   * users whose employeeNumber equals `employeeNumber`. Returns every distinct candidate.
   */
  findUsersByExactIdentity(
    identity: { login: string; employeeNumber: string },
    options?: OktaCallOptions,
  ): Promise<OktaUser[]>;
  /** Creates a STAGED user (activate=false: no activation email, no credentials). Never retried. */
  createUser(profile: OktaNewUser, options?: OktaCallOptions): Promise<OktaUser>;
  getGroup(groupId: string, options?: OktaCallOptions): Promise<OktaGroup | null>;
  isUserInGroup(userId: string, groupId: string, options?: OktaCallOptions): Promise<boolean>;
  /** Adds the membership (PUT, idempotent at Okta). Never retried by the client. */
  addUserToGroup(groupId: string, userId: string, options?: OktaCallOptions): Promise<void>;
}

const MAX_RETRY_AFTER_MS = 10_000;
const MAX_PAGES = 20;
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET_BEFORE_SEND",
]);

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Values that go into Okta search expressions must not be able to break out of the quotes. */
function assertSearchSafe(operation: string, name: string, value: string) {
  if (!value || /["\\\r\n]/.test(value) || value.length > 200) {
    throw new OktaError("REQUEST_INVALID", operation, `${name} is not a safe exact-search value`);
  }
}

function assertId(operation: string, kind: "user" | "group", id: string) {
  if (!(kind === "user" ? OKTA_USER_ID : OKTA_GROUP_ID).test(id)) {
    throw new OktaError("REQUEST_INVALID", operation, `malformed Okta ${kind} id`);
  }
}

function waitHint(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
    return Math.min(Math.max(Number(retryAfter), 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  const reset = Number(res.headers.get("x-rate-limit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

async function oktaErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { errorCode?: unknown };
    return typeof body.errorCode === "string" && /^E\d{7}$/.test(body.errorCode)
      ? body.errorCode
      : undefined;
  } catch {
    return undefined;
  }
}

export function createOktaClient(
  config: OktaConfig,
  deps: {
    fetch?: typeof fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    logger?: OktaClientLogger;
  } = {},
): OktaClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepFor;
  const logger = deps.logger;
  const headers = {
    Authorization: `SSWS ${config.apiToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const scrub = (text: string) => redactOktaText(text, [config.apiToken]);

  /** Maps a non-2xx response to a typed error. `write` changes what "sent" means. */
  async function errorFor(operation: string, res: Response, write: boolean): Promise<OktaError> {
    const status = res.status;
    const code = await oktaErrorCode(res);
    const detail = `HTTP ${status}${code ? ` (${code})` : ""}`;
    const base = { status, ...(code && { oktaErrorCode: code }) };
    if (status === 401) return new OktaError("AUTHENTICATION_FAILED", operation, detail, base);
    if (status === 403) return new OktaError("PERMISSION_DENIED", operation, detail, base);
    if (status === 404) return new OktaError("NOT_FOUND", operation, detail, base);
    if (status === 429) {
      const wait = waitHint(res);
      // A rate-limited request was rejected before processing.
      return new OktaError("RATE_LIMITED", operation, detail, {
        ...base,
        retryable: true,
        notSent: true,
        ...(wait !== undefined && { retryAfterMs: wait }),
      });
    }
    if (status >= 500) {
      return write
        ? new OktaError("OUTCOME_UNKNOWN", operation, detail, { ...base, retryable: true })
        : new OktaError("UNAVAILABLE", operation, detail, { ...base, retryable: true });
    }
    if (status >= 300 && status < 400) {
      return new OktaError("UNEXPECTED_REDIRECT", operation, detail, base);
    }
    return new OktaError("BAD_REQUEST", operation, detail, base);
  }

  function transportError(operation: string, err: unknown, write: boolean): OktaError {
    const name = (err as { name?: string }).name;
    const causeCode = (err as { cause?: { code?: string } }).cause?.code;
    if (name === "TimeoutError" || name === "AbortError") {
      return write
        ? new OktaError("OUTCOME_UNKNOWN", operation, "request timed out", { retryable: true })
        : new OktaError("TIMEOUT", operation, "request timed out", { retryable: true });
    }
    if (causeCode && NOT_SENT_CODES.has(causeCode)) {
      return new OktaError("UNAVAILABLE", operation, `connection failed (${causeCode})`, {
        retryable: true,
        notSent: true,
      });
    }
    return write
      ? new OktaError(
          "OUTCOME_UNKNOWN",
          operation,
          scrub(`network error: ${(err as Error).message}`),
          {
            retryable: true,
          },
        )
      : new OktaError("UNAVAILABLE", operation, scrub(`network error: ${(err as Error).message}`), {
          retryable: true,
        });
  }

  /** One HTTP exchange with a per-attempt timeout bounded by the caller's deadline. */
  async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const attempt = AbortSignal.timeout(config.timeoutMs);
    return doFetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, attempt]) : attempt,
    });
  }

  /** GET with bounded retries (network, timeout, 429, 5xx). 404 → null. */
  async function read(operation: string, path: string, options: OktaCallOptions = {}) {
    const url = new URL(path, config.baseUrl).toString();
    const attempts = config.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      let failure: OktaError;
      try {
        const res = await send(url, { method: "GET" }, options.signal);
        if (res.status === 404) return null;
        if (res.ok) {
          try {
            return { body: (await res.json()) as unknown, headers: res.headers };
          } catch {
            throw new OktaError("MALFORMED_RESPONSE", operation, "response body is not JSON", {
              status: res.status,
            });
          }
        }
        failure = await errorFor(operation, res, false);
      } catch (err) {
        if (err instanceof OktaError) throw err;
        failure = transportError(operation, err, false);
      }
      if (!failure.retryable || attempt >= attempts || options.signal?.aborted) throw failure;
      const backoff = config.retryBaseMs * 2 ** (attempt - 1);
      const wait = failure.retryAfterMs ?? backoff / 2 + Math.random() * (backoff / 2);
      logger?.warn(
        { operation, attempt, code: failure.code, waitMs: Math.round(wait) },
        "okta retry",
      );
      await sleep(wait, options.signal);
    }
  }

  /** A single write attempt. Never retried here: the durable executor reconciles. */
  async function write(
    operation: string,
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    options: OktaCallOptions = {},
  ): Promise<unknown> {
    const url = new URL(path, config.baseUrl).toString();
    let res: Response;
    try {
      res = await send(
        url,
        { method, ...(body !== undefined && { body: JSON.stringify(body) }) },
        options.signal,
      );
    } catch (err) {
      throw transportError(operation, err, true);
    }
    if (!res.ok) throw await errorFor(operation, res, true);
    if (res.status === 204) return null;
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new OktaError("OUTCOME_UNKNOWN", operation, "unreadable success response", {
        status: res.status,
        retryable: true,
      });
    }
  }

  function parseUser(operation: string, body: unknown): OktaUser {
    const parsed = OktaUserSchema.safeParse(body);
    if (!parsed.success) {
      throw new OktaError("MALFORMED_RESPONSE", operation, "unexpected user shape");
    }
    return parsed.data;
  }

  return {
    async verifyCredentials(options) {
      const res = await read("verifyCredentials", "/api/v1/users/me", options);
      if (!res)
        throw new OktaError("AUTHENTICATION_FAILED", "verifyCredentials", "no current user");
      return true;
    },

    async getUser(userId, options) {
      assertId("getUser", "user", userId);
      const res = await read("getUser", `/api/v1/users/${userId}`, options);
      return res ? parseUser("getUser", res.body) : null;
    },

    async findUsersByExactIdentity({ login, employeeNumber }, options) {
      const op = "findUsersByExactIdentity";
      assertSearchSafe(op, "login", login);
      assertSearchSafe(op, "employeeNumber", employeeNumber);
      const candidates = new Map<string, OktaUser>();
      // 1. By login: an id-or-login lookup, strongly consistent and exact.
      const byLogin = await read(op, `/api/v1/users/${encodeURIComponent(login)}`, options);
      if (byLogin) {
        const user = parseUser(op, byLogin.body);
        if (user.profile.login.toLowerCase() === login.toLowerCase()) candidates.set(user.id, user);
      }
      // 2. By employeeNumber: an exact search expression (catches another account for the same
      //    employee under a different login).
      const search = new URLSearchParams({
        search: `profile.employeeNumber eq "${employeeNumber}"`,
        limit: "10",
      });
      const byNumber = await read(op, `/api/v1/users?${search}`, options);
      const list = Array.isArray(byNumber?.body) ? byNumber.body : [];
      for (const item of list) {
        const user = parseUser(op, item);
        if (user.profile.employeeNumber === employeeNumber) candidates.set(user.id, user);
      }
      return [...candidates.values()];
    },

    async createUser(profile, options) {
      const op = "createUser";
      const parsed = OktaNewUserSchema.safeParse(profile);
      if (!parsed.success) throw new OktaError("REQUEST_INVALID", op, "invalid new-user profile");
      const body = await write(
        op,
        "POST",
        "/api/v1/users?activate=false",
        { profile: parsed.data },
        options,
      );
      return parseUser(op, body);
    },

    async getGroup(groupId, options) {
      assertId("getGroup", "group", groupId);
      const res = await read("getGroup", `/api/v1/groups/${groupId}`, options);
      if (!res) return null;
      const parsed = OktaGroupSchema.safeParse(res.body);
      if (!parsed.success)
        throw new OktaError("MALFORMED_RESPONSE", "getGroup", "unexpected group shape");
      return parsed.data;
    },

    async isUserInGroup(userId, groupId, options) {
      const op = "isUserInGroup";
      assertId(op, "user", userId);
      assertId(op, "group", groupId);
      let path: string | null = `/api/v1/users/${userId}/groups?limit=200`;
      for (let page = 0; path && page < MAX_PAGES; page++) {
        const res = await read(op, path, options);
        if (!res) throw new OktaError("NOT_FOUND", op, "user not found");
        const groups = Array.isArray(res.body) ? res.body : [];
        if (groups.some((g) => (g as { id?: unknown }).id === groupId)) return true;
        // Follow Okta's Link: <...>; rel="next" pagination, same origin only.
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
        path =
          next && new URL(next).origin === config.baseUrl
            ? new URL(next).pathname + new URL(next).search
            : null;
      }
      return false;
    },

    async addUserToGroup(groupId, userId, options) {
      const op = "addUserToGroup";
      assertId(op, "group", groupId);
      assertId(op, "user", userId);
      await write(op, "PUT", `/api/v1/groups/${groupId}/users/${userId}`, undefined, options);
    },
  };
}
