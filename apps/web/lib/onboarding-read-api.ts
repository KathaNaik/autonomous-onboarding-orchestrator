import {
  ObservabilityErrorResponseSchema,
  WorkflowListResponseSchema,
  WorkflowObservabilityViewSchema,
  type ObservabilityErrorResponse,
  type WorkflowListResponse,
  type WorkflowObservabilityView,
} from "@aoo/shared";
import { z } from "zod";
import { loadWebConfig } from "./config";

export type ReadResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: ObservabilityErrorResponse };

const UNAVAILABLE: ObservabilityErrorResponse = {
  error: "INTERNAL_ERROR",
  message: "The onboarding service is unavailable. Try again shortly.",
};
const NOT_FOUND: ObservabilityErrorResponse = {
  error: "WORKFLOW_NOT_FOUND",
  message: "Onboarding not found.",
};

/**
 * (M9) Server-side client for the API's read-only operator routes. Runs only on the Next.js
 * server: it attaches the server-only ONBOARDING_ADMIN_TOKEN and the authenticated session's
 * operator id. Every response is validated against the M9 contracts. Browser code never calls it.
 */
async function get<T>(
  schema: z.ZodType<T>,
  path: string,
  operatorId: string,
  fetchImpl: typeof fetch,
): Promise<ReadResult<T>> {
  const config = loadWebConfig();
  if (!config.ONBOARDING_ADMIN_TOKEN) return { ok: false, status: 503, body: UNAVAILABLE };
  let res: Response;
  try {
    res = await fetchImpl(new URL(path, config.API_BASE_URL), {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.ONBOARDING_ADMIN_TOKEN}`,
        "x-operator-id": operatorId,
      },
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 502, body: UNAVAILABLE };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const body = schema.safeParse(json);
    return body.success
      ? { ok: true, status: res.status, body: body.data }
      : { ok: false, status: 502, body: UNAVAILABLE };
  }
  const error = ObservabilityErrorResponseSchema.safeParse(json);
  return { ok: false, status: res.status, body: error.success ? error.data : UNAVAILABLE };
}

/** Allowed list-query fields; each is validated on its own and dropped if invalid. */
const LIST_QUERY_FIELDS: Record<string, RegExp> = {
  limit: /^\d{1,3}$/,
  cursor: /^[A-Za-z0-9_-]{1,200}$/,
  state: /^[A-Z_]{1,40}$/,
};

export function listQuery(input: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, pattern] of Object.entries(LIST_QUERY_FIELDS)) {
    const raw = input[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && pattern.test(value)) params.set(key, value);
  }
  return params;
}

export function fetchWorkflowList(
  params: URLSearchParams,
  operatorId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadResult<WorkflowListResponse>> {
  const qs = params.toString();
  return get(
    WorkflowListResponseSchema,
    `/admin/onboarding${qs ? `?${qs}` : ""}`,
    operatorId,
    fetchImpl,
  );
}

export async function fetchWorkflowView(
  workflowId: string,
  operatorId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadResult<WorkflowObservabilityView>> {
  if (!z.uuid().safeParse(workflowId).success) return { ok: false, status: 404, body: NOT_FOUND };
  return get(
    WorkflowObservabilityViewSchema,
    `/admin/onboarding/${workflowId}`,
    operatorId,
    fetchImpl,
  );
}
