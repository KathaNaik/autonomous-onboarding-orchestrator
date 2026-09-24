import type { ServiceNowConfig } from "./config.js";
import {
  ServiceNowAuthError,
  ServiceNowError,
  ServiceNowPermissionError,
  ServiceNowRequestError,
  ServiceNowResponseError,
  ServiceNowTimeoutError,
  ServiceNowUnavailableError,
} from "./errors.js";
import { redact, safeUrl } from "./redact.js";
import {
  ACCESS_REQUEST_FIELDS,
  AccessRequestQuerySchema,
  AccessRequestRecordSchema,
  ChoiceEntrySchema,
  DictionaryEntrySchema,
  ListEnvelopeSchema,
  SingleEnvelopeSchema,
  SysIdSchema,
  TableObjectSchema,
  type AccessRequestQuery,
  type AccessRequestRecord,
} from "./schemas.js";
import { ACCESS_REQUEST_TABLE_SPEC } from "./table-spec.js";
import type { z } from "zod";

/** Structured logger (pino-compatible subset). Receives only redacted, credential-free data. */
export interface ServiceNowLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface ServiceNowClientOptions {
  fetch?: typeof fetch;
  logger?: ServiceNowLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ConnectivityResult {
  instanceUrl: string;
  table: string;
  username: string;
  /** Records visible to this user in the table (sampled with limit 1: 0 or 1). */
  sampleCount: number;
  latencyMs: number;
}

export interface TableDescription {
  name: string;
  label: string;
  superClass: string;
  scope: string;
  columns: Array<{
    name: string;
    internalType: string;
    maxLength: number;
    mandatory: boolean;
    unique: boolean;
    defaultValue: string;
  }>;
  /** Active choice values per column (sys_choice). */
  choices: Record<string, string[]>;
}

/** Read-only ServiceNow Table API client. Independent of workflows: no orchestrator imports. */
export interface ServiceNowClient {
  /** Authenticates and reads (at most) one row from the access-request table. */
  verifyConnectivity(): Promise<ConnectivityResult>;
  queryAccessRequests(query?: AccessRequestQuery): Promise<AccessRequestRecord[]>;
  /** null when no record with this sys_id exists (or it is not visible to the user). */
  getAccessRequest(sysId: string): Promise<AccessRequestRecord | null>;
  /** Reads table metadata (sys_db_object, sys_dictionary); needs dictionary read rights. */
  describeAccessRequestTable(): Promise<TableDescription>;
}

const noopLogger: ServiceNowLogger = { debug: () => {}, warn: () => {} };
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Encoded-query values may not contain "^" (the condition separator, which also introduces
 * operators such as ^OR, ^NQ and ^ORDERBY) or line breaks, so a value can never alter the query.
 */
function queryValue(operation: string, field: string, value: string): string {
  if (/[\^\r\n]/.test(value)) {
    throw new ServiceNowRequestError(
      operation,
      `${field} contains characters not allowed in a query`,
    );
  }
  return value;
}

export function createServiceNowClient(
  config: ServiceNowConfig,
  options: ServiceNowClientOptions = {},
): ServiceNowClient {
  const fetchImpl = options.fetch ?? fetch;
  const logger = options.logger ?? noopLogger;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const table = config.accessRequestTable;

  /** GET with timeout, bounded retries for transient failures, and status → error mapping. */
  async function get(
    operation: string,
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(path, config.instanceUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const attempts = config.maxRetries + 1;
    let lastError: ServiceNowError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        const backoff = config.retryBaseMs * 2 ** (attempt - 2);
        await sleep(Math.round(backoff / 2 + random() * (backoff / 2)));
      }
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: authorization, Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        lastError = timedOut
          ? new ServiceNowTimeoutError(operation, config.timeoutMs, attempt)
          : new ServiceNowUnavailableError(operation, "network error reaching the instance", {
              cause: redact(err),
            });
        logger.warn(
          { operation, url: safeUrl(url), attempt, attempts, err: lastError.toJSON() },
          "servicenow request failed",
        );
        continue;
      }

      const durationMs = Date.now() - started;
      logger.debug(
        { operation, method: "GET", url: safeUrl(url), status: res.status, attempt, durationMs },
        "servicenow request",
      );

      if (res.status === 200) {
        const contentType = res.headers.get("content-type") ?? "";
        const text = await res.text();
        if (text.length > MAX_BODY_BYTES) {
          throw new ServiceNowResponseError(
            "MALFORMED_RESPONSE",
            operation,
            "response too large",
            200,
          );
        }
        if (!contentType.includes("application/json")) {
          // A hibernating/waking PDI serves an HTML page instead of JSON.
          throw new ServiceNowUnavailableError(
            operation,
            "instance returned a non-JSON response (a developer instance may be hibernating; wake it at developer.servicenow.com)",
            { status: 200, instanceUnavailable: true },
          );
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new ServiceNowResponseError(
            "MALFORMED_RESPONSE",
            operation,
            "response is not valid JSON",
            200,
          );
        }
      }

      await res.body?.cancel().catch(() => {});
      if (res.status === 401) throw new ServiceNowAuthError(operation);
      if (res.status === 403) throw new ServiceNowPermissionError(operation);
      if (res.status === 404) {
        throw new ServiceNowResponseError("NOT_FOUND", operation, "not found (404)", 404);
      }
      if (res.status >= 300 && res.status < 400) {
        throw new ServiceNowUnavailableError(
          operation,
          `instance redirected (${res.status}); a developer instance may be hibernating`,
          { status: res.status, instanceUnavailable: true },
        );
      }
      if (res.status === 400) {
        throw new ServiceNowResponseError(
          "BAD_REQUEST",
          operation,
          "request rejected (400): check the table name and field names",
          400,
        );
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        lastError = new ServiceNowUnavailableError(operation, `instance returned ${res.status}`, {
          status: res.status,
        });
        const retryAfter = Number(res.headers.get("retry-after"));
        logger.warn(
          { operation, url: safeUrl(url), status: res.status, attempt, attempts },
          "servicenow transient failure",
        );
        if (attempt < attempts && Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS));
        }
        continue;
      }
      throw new ServiceNowResponseError(
        "UNEXPECTED_STATUS",
        operation,
        `unexpected status ${res.status}`,
        res.status,
      );
    }
    throw lastError!;
  }

  function parse<T extends z.ZodType>(schema: T, value: unknown, operation: string): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ServiceNowResponseError(
        "SCHEMA_MISMATCH",
        operation,
        `response did not match the expected schema (${issues})`,
      );
    }
    return parsed.data;
  }

  const recordParams = {
    sysparm_fields: ACCESS_REQUEST_FIELDS.join(","),
    sysparm_display_value: "false",
    sysparm_exclude_reference_link: "true",
  };

  return {
    async verifyConnectivity() {
      const operation = "verifyConnectivity";
      const started = Date.now();
      const body = await get(operation, `/api/now/table/${table}`, {
        sysparm_limit: "1",
        sysparm_fields: "sys_id",
        sysparm_exclude_reference_link: "true",
      });
      const { result } = parse(ListEnvelopeSchema, body, operation);
      return {
        instanceUrl: config.instanceUrl,
        table,
        username: config.username,
        sampleCount: result.length,
        latencyMs: Date.now() - started,
      };
    },

    async queryAccessRequests(rawQuery = {}) {
      const operation = "queryAccessRequests";
      const query = AccessRequestQuerySchema.safeParse(rawQuery);
      if (!query.success)
        throw new ServiceNowRequestError(operation, query.error.issues[0]!.message);
      const q = query.data;
      const conditions = [
        q.employeeId !== undefined &&
          `employee_id=${queryValue(operation, "employeeId", q.employeeId)}`,
        q.workflowId !== undefined &&
          `workflow_id=${queryValue(operation, "workflowId", q.workflowId)}`,
        q.correlationKey !== undefined &&
          `correlation_key=${queryValue(operation, "correlationKey", q.correlationKey)}`,
      ].filter((c): c is string => typeof c === "string");

      const body = await get(operation, `/api/now/table/${table}`, {
        ...recordParams,
        sysparm_query: [...conditions, "ORDERBYDESCsys_created_on"].join("^"),
        sysparm_limit: String(q.limit),
        sysparm_offset: String(q.offset),
      });
      const { result } = parse(ListEnvelopeSchema, body, operation);
      return result.map((r) => parse(AccessRequestRecordSchema, r, operation));
    },

    async getAccessRequest(sysId) {
      const operation = "getAccessRequest";
      if (!SysIdSchema.safeParse(sysId).success) {
        throw new ServiceNowRequestError(operation, "sysId must be a 32-character hex sys_id");
      }
      try {
        const body = await get(operation, `/api/now/table/${table}/${sysId}`, recordParams);
        return parse(
          AccessRequestRecordSchema,
          parse(SingleEnvelopeSchema, body, operation).result,
          operation,
        );
      } catch (err) {
        if (err instanceof ServiceNowError && err.code === "NOT_FOUND") return null;
        throw err;
      }
    },

    async describeAccessRequestTable() {
      const operation = "describeAccessRequestTable";
      const objects = parse(
        ListEnvelopeSchema,
        await get(operation, "/api/now/table/sys_db_object", {
          sysparm_query: `name=${table}`,
          sysparm_fields: "name,label,super_class.name,sys_scope.scope",
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "1",
        }),
        operation,
      ).result;
      if (objects.length === 0) {
        throw new ServiceNowResponseError(
          "NOT_FOUND",
          operation,
          `table ${table} not found in sys_db_object (or not readable by this user)`,
        );
      }
      const object = parse(TableObjectSchema, objects[0], operation);
      const entries = parse(
        ListEnvelopeSchema,
        await get(operation, "/api/now/table/sys_dictionary", {
          sysparm_query: `name=${table}^elementISNOTEMPTY`,
          sysparm_fields: "element,internal_type,max_length,mandatory,unique,default_value",
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "500",
        }),
        operation,
      ).result.map((e) => parse(DictionaryEntrySchema, e, operation));
      const choiceRows = parse(
        ListEnvelopeSchema,
        await get(operation, "/api/now/table/sys_choice", {
          // Filter inactive rows here: an encoded `inactive=false` condition matched no rows on a
          // real PDI even though every row reports inactive "false".
          sysparm_query: `name=${table}^ORDERBYsequence`,
          sysparm_fields: "element,value,label,inactive",
          sysparm_limit: "500",
        }),
        operation,
      ).result.map((c) => parse(ChoiceEntrySchema, c, operation));
      const choices: Record<string, string[]> = {};
      for (const c of choiceRows) {
        if (c.inactive !== "true") (choices[c.element] ??= []).push(c.value);
      }

      return {
        name: object.name,
        label: object.label,
        superClass: object["super_class.name"],
        scope: object["sys_scope.scope"],
        columns: entries.map((e) => ({
          name: e.element,
          internalType: e.internal_type,
          maxLength: Number(e.max_length),
          mandatory: e.mandatory === "true",
          unique: e.unique === "true",
          defaultValue: e.default_value,
        })),
        choices,
      };
    },
  };
}

/** Compares a live table description with ACCESS_REQUEST_TABLE_SPEC; returns problems (empty = OK). */
export function checkAccessRequestTable(description: TableDescription): string[] {
  const problems: string[] = [];
  if (description.superClass !== ACCESS_REQUEST_TABLE_SPEC.extends) {
    problems.push(`table extends "${description.superClass || "(nothing)"}", expected "task"`);
  }
  if (!description.scope.startsWith("x_")) {
    problems.push(
      `table is in scope "${description.scope}", expected a scoped application (x_...)`,
    );
  }
  const byName = new Map(description.columns.map((c) => [c.name, c]));
  for (const spec of ACCESS_REQUEST_TABLE_SPEC.columns) {
    const col = byName.get(spec.name);
    if (!col) {
      problems.push(`missing column ${spec.name}`);
      continue;
    }
    const typeOk =
      spec.type === "choice"
        ? ["choice", "string"].includes(col.internalType)
        : col.internalType === "string";
    if (!typeOk)
      problems.push(`column ${spec.name} has type ${col.internalType}, expected ${spec.type}`);
    if (col.maxLength < spec.maxLength) {
      problems.push(`column ${spec.name} max length ${col.maxLength} < ${spec.maxLength}`);
    }
    if ("unique" in spec && spec.unique && !col.unique)
      problems.push(`column ${spec.name} must be unique`);
    if ("choices" in spec && spec.choices) {
      const actual = description.choices[spec.name] ?? [];
      const missing = spec.choices.filter((v) => !actual.includes(v));
      const extra = actual.filter((v) => !(spec.choices as readonly string[]).includes(v));
      if (missing.length)
        problems.push(`column ${spec.name} is missing choices: ${missing.join(", ")}`);
      if (extra.length)
        problems.push(`column ${spec.name} has unexpected choices: ${extra.join(", ")}`);
    }
    if ("defaultValue" in spec && col.defaultValue !== spec.defaultValue) {
      problems.push(
        `column ${spec.name} default is "${col.defaultValue}", expected "${spec.defaultValue}"`,
      );
    }
  }
  return problems;
}
