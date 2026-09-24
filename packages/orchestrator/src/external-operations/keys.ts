import { createHash } from "node:crypto";

export const SERVICENOW_CREATE_ACCESS_REQUEST = "servicenow.create_access_request";
export const DEFAULT_CORRELATION_PREFIX = "aoo-oar-";

export interface AccessRequestIdentity {
  workflowId: string;
  resourceId: string;
  requestedEntitlement: string;
}

/**
 * Deterministic keys for "create the ServiceNow access request for (workflow, resource,
 * entitlement)". The same logical request always yields the same keys, across retries,
 * processes and redeliveries.
 *  - idempotencyKey: local identity (unique in external_operations)
 *  - correlationKey: provider-side identity (unique in the ServiceNow table). A hash keeps it
 *    short, query-safe and free of resource/employee details.
 */
export function serviceNowAccessRequestKeys(
  identity: AccessRequestIdentity,
  prefix: string = DEFAULT_CORRELATION_PREFIX,
): { idempotencyKey: string; correlationKey: string } {
  const idempotencyKey = [
    SERVICENOW_CREATE_ACCESS_REQUEST,
    identity.workflowId,
    identity.resourceId,
    identity.requestedEntitlement,
  ].join(":");
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40);
  return { idempotencyKey, correlationKey: `${prefix}${digest}` };
}
