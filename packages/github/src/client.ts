import type { GitHubConfig } from "./config.js";
import { GitHubError } from "./errors.js";
import { redactGitHubText } from "./redact.js";
import {
  GITHUB_LOGIN,
  GITHUB_TEAM_SLUG,
  GitHubOrganizationSchema,
  GitHubOrgMembershipSchema,
  GitHubTeamMembershipSchema,
  GitHubTeamSchema,
  GitHubUserSchema,
  type GitHubOrganization,
  type GitHubOrgMembership,
  type GitHubTeam,
  type GitHubTeamMembership,
  type GitHubUser,
} from "./schemas.js";

export interface GitHubCallOptions {
  signal?: AbortSignal;
}

export interface GitHubClientLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Narrow, additive GitHub operations for M7B. No generic request method; no repository, owner,
 * team-creation, removal, suspension, secret or deploy-key operations. Writes only ever request
 * the ordinary `member` role.
 */
export interface GitHubClient {
  /** Credential check (GET /user) for the read-only preflight. */
  verifyCredentials(options?: GitHubCallOptions): Promise<true>;
  /** Exactly this login; null when it does not exist. Never a search. */
  getUserByLogin(login: string, options?: GitHubCallOptions): Promise<GitHubUser | null>;
  /** By immutable numeric id (detects login changes). */
  getUserById(id: number, options?: GitHubCallOptions): Promise<GitHubUser | null>;
  getOrganization(org: string, options?: GitHubCallOptions): Promise<GitHubOrganization | null>;
  /** Active or pending (invitation) membership; null when neither exists. */
  getOrgMembership(
    org: string,
    login: string,
    options?: GitHubCallOptions,
  ): Promise<GitHubOrgMembership | null>;
  /** PUT membership with role `member`: invites a non-member. Never retried by the client. */
  setOrgMembership(
    org: string,
    login: string,
    options?: GitHubCallOptions,
  ): Promise<GitHubOrgMembership>;
  getTeam(org: string, slug: string, options?: GitHubCallOptions): Promise<GitHubTeam | null>;
  getTeamMembership(
    org: string,
    slug: string,
    login: string,
    options?: GitHubCallOptions,
  ): Promise<GitHubTeamMembership | null>;
  /** PUT team membership with role `member`. Never retried by the client. */
  addTeamMembership(
    org: string,
    slug: string,
    login: string,
    options?: GitHubCallOptions,
  ): Promise<GitHubTeamMembership>;
}

const MAX_RETRY_AFTER_MS = 10_000;
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function assertLogin(op: string, what: string, value: string) {
  if (!GITHUB_LOGIN.test(value))
    throw new GitHubError("REQUEST_INVALID", op, `${what} is not a valid GitHub login`);
}
function assertSlug(op: string, value: string) {
  if (!GITHUB_TEAM_SLUG.test(value))
    throw new GitHubError("REQUEST_INVALID", op, "invalid team slug");
}

function waitHint(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
    return Math.min(Math.max(Number(retryAfter), 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

export function createGitHubClient(
  config: GitHubConfig,
  deps: {
    fetch?: typeof fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    logger?: GitHubClientLogger;
  } = {},
): GitHubClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepFor;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "aoo-onboarding-orchestrator",
    "Content-Type": "application/json",
  };
  const scrub = (text: string) => redactGitHubText(text, [config.token]);

  function errorFor(operation: string, res: Response, write: boolean): GitHubError {
    const status = res.status;
    const detail = `HTTP ${status}`;
    // Primary/secondary rate limits: 429, or 403 with Retry-After / exhausted quota.
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (res.headers.get("retry-after") !== null ||
          res.headers.get("x-ratelimit-remaining") === "0"));
    if (rateLimited) {
      const wait = waitHint(res);
      return new GitHubError("RATE_LIMITED", operation, detail, {
        status,
        retryable: true,
        notSent: true,
        ...(wait !== undefined && { retryAfterMs: wait }),
      });
    }
    if (status === 401)
      return new GitHubError("AUTHENTICATION_FAILED", operation, detail, { status });
    if (status === 403) return new GitHubError("PERMISSION_DENIED", operation, detail, { status });
    if (status === 404) return new GitHubError("NOT_FOUND", operation, detail, { status });
    if (status >= 500) {
      return write
        ? new GitHubError("OUTCOME_UNKNOWN", operation, detail, { status, retryable: true })
        : new GitHubError("UNAVAILABLE", operation, detail, { status, retryable: true });
    }
    if (status >= 300 && status < 400)
      return new GitHubError("UNEXPECTED_REDIRECT", operation, detail, { status });
    return new GitHubError("BAD_REQUEST", operation, detail, { status });
  }

  function transportError(operation: string, err: unknown, write: boolean): GitHubError {
    const name = (err as { name?: string }).name;
    const causeCode = (err as { cause?: { code?: string } }).cause?.code;
    if (name === "TimeoutError" || name === "AbortError") {
      return write
        ? new GitHubError("OUTCOME_UNKNOWN", operation, "request timed out", { retryable: true })
        : new GitHubError("TIMEOUT", operation, "request timed out", { retryable: true });
    }
    if (causeCode && NOT_SENT_CODES.has(causeCode)) {
      return new GitHubError("UNAVAILABLE", operation, `connection failed (${causeCode})`, {
        retryable: true,
        notSent: true,
      });
    }
    const message = scrub(`network error: ${(err as Error).message}`);
    return write
      ? new GitHubError("OUTCOME_UNKNOWN", operation, message, { retryable: true })
      : new GitHubError("UNAVAILABLE", operation, message, { retryable: true });
  }

  function send(path: string, init: RequestInit, signal?: AbortSignal) {
    const attempt = AbortSignal.timeout(config.timeoutMs);
    return doFetch(`${config.apiUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, attempt]) : attempt,
    });
  }

  /** GET with bounded retries. 404 → null. */
  async function read(
    operation: string,
    path: string,
    options: GitHubCallOptions = {},
  ): Promise<unknown | null> {
    const attempts = config.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      let failure: GitHubError;
      try {
        const res = await send(path, { method: "GET" }, options.signal);
        if (res.status === 404) return null;
        if (res.ok) {
          try {
            return (await res.json()) as unknown;
          } catch {
            throw new GitHubError("MALFORMED_RESPONSE", operation, "response body is not JSON", {
              status: res.status,
            });
          }
        }
        failure = errorFor(operation, res, false);
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        failure = transportError(operation, err, false);
      }
      if (!failure.retryable || attempt >= attempts || options.signal?.aborted) throw failure;
      const backoff = config.retryBaseMs * 2 ** (attempt - 1);
      const wait = failure.retryAfterMs ?? backoff / 2 + Math.random() * (backoff / 2);
      deps.logger?.warn(
        { operation, attempt, code: failure.code, waitMs: Math.round(wait) },
        "github retry",
      );
      await sleep(wait, options.signal);
    }
  }

  /** One write attempt; never retried here. */
  async function write(
    operation: string,
    path: string,
    body: unknown,
    options: GitHubCallOptions = {},
  ) {
    let res: Response;
    try {
      res = await send(path, { method: "PUT", body: JSON.stringify(body) }, options.signal);
    } catch (err) {
      throw transportError(operation, err, true);
    }
    if (!res.ok) throw errorFor(operation, res, true);
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new GitHubError("OUTCOME_UNKNOWN", operation, "unreadable success response", {
        status: res.status,
        retryable: true,
      });
    }
  }

  function parse<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    op: string,
    body: unknown,
  ): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new GitHubError("MALFORMED_RESPONSE", op, "unexpected response shape");
    return parsed.data;
  }

  const enc = encodeURIComponent;
  return {
    async verifyCredentials(options) {
      const body = await read("verifyCredentials", "/user", options);
      if (!body)
        throw new GitHubError(
          "AUTHENTICATION_FAILED",
          "verifyCredentials",
          "no authenticated user",
        );
      return true;
    },
    async getUserByLogin(login, options) {
      assertLogin("getUserByLogin", "login", login);
      const body = await read("getUserByLogin", `/users/${enc(login)}`, options);
      return body === null ? null : parse(GitHubUserSchema, "getUserByLogin", body);
    },
    async getUserById(id, options) {
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new GitHubError("REQUEST_INVALID", "getUserById", "invalid id");
      const body = await read("getUserById", `/user/${id}`, options);
      return body === null ? null : parse(GitHubUserSchema, "getUserById", body);
    },
    async getOrganization(org, options) {
      assertLogin("getOrganization", "org", org);
      const body = await read("getOrganization", `/orgs/${enc(org)}`, options);
      return body === null ? null : parse(GitHubOrganizationSchema, "getOrganization", body);
    },
    async getOrgMembership(org, login, options) {
      assertLogin("getOrgMembership", "org", org);
      assertLogin("getOrgMembership", "login", login);
      const body = await read(
        "getOrgMembership",
        `/orgs/${enc(org)}/memberships/${enc(login)}`,
        options,
      );
      return body === null ? null : parse(GitHubOrgMembershipSchema, "getOrgMembership", body);
    },
    async setOrgMembership(org, login, options) {
      assertLogin("setOrgMembership", "org", org);
      assertLogin("setOrgMembership", "login", login);
      const body = await write(
        "setOrgMembership",
        `/orgs/${enc(org)}/memberships/${enc(login)}`,
        { role: "member" },
        options,
      );
      return parse(GitHubOrgMembershipSchema, "setOrgMembership", body);
    },
    async getTeam(org, slug, options) {
      assertLogin("getTeam", "org", org);
      assertSlug("getTeam", slug);
      const body = await read("getTeam", `/orgs/${enc(org)}/teams/${enc(slug)}`, options);
      return body === null ? null : parse(GitHubTeamSchema, "getTeam", body);
    },
    async getTeamMembership(org, slug, login, options) {
      assertLogin("getTeamMembership", "org", org);
      assertSlug("getTeamMembership", slug);
      assertLogin("getTeamMembership", "login", login);
      const body = await read(
        "getTeamMembership",
        `/orgs/${enc(org)}/teams/${enc(slug)}/memberships/${enc(login)}`,
        options,
      );
      return body === null ? null : parse(GitHubTeamMembershipSchema, "getTeamMembership", body);
    },
    async addTeamMembership(org, slug, login, options) {
      assertLogin("addTeamMembership", "org", org);
      assertSlug("addTeamMembership", slug);
      assertLogin("addTeamMembership", "login", login);
      const body = await write(
        "addTeamMembership",
        `/orgs/${enc(org)}/teams/${enc(slug)}/memberships/${enc(login)}`,
        { role: "member" },
        options,
      );
      return parse(GitHubTeamMembershipSchema, "addTeamMembership", body);
    },
  };
}
