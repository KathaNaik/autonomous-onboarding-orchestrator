import { z } from "zod";
import { POLICY_DECISIONS } from "./table-spec.js";

/** ServiceNow sys_id: 32 lowercase hex characters. */
export const SysIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "must be a 32-character hex sys_id");

/** Fields requested from the Table API (sysparm_fields); Task-inherited fields first. */
export const ACCESS_REQUEST_FIELDS = [
  "sys_id",
  "sys_class_name",
  "number",
  "state",
  "short_description",
  "sys_created_on",
  "sys_updated_on",
  "employee_id",
  "workflow_id",
  "resource_id",
  "requested_entitlement",
  "agent_reason",
  "policy_decision",
  "correlation_key",
] as const;

// With sysparm_display_value=false and sysparm_exclude_reference_link=true, every field is a string.
const Field = z.string();

export const AccessRequestRecordSchema = z
  .object({
    sys_id: SysIdSchema,
    sys_class_name: Field,
    number: Field,
    state: Field,
    short_description: Field,
    sys_created_on: Field,
    sys_updated_on: Field,
    employee_id: Field,
    workflow_id: Field,
    resource_id: Field,
    requested_entitlement: Field,
    agent_reason: Field,
    policy_decision: z.union([z.enum(POLICY_DECISIONS), z.literal("")]),
    correlation_key: Field,
  })
  .transform((r) => ({
    sysId: r.sys_id,
    sysClassName: r.sys_class_name,
    number: r.number,
    state: r.state,
    shortDescription: r.short_description,
    createdOn: r.sys_created_on,
    updatedOn: r.sys_updated_on,
    employeeId: r.employee_id,
    workflowId: r.workflow_id,
    resourceId: r.resource_id,
    requestedEntitlement: r.requested_entitlement,
    agentReason: r.agent_reason,
    policyDecision: r.policy_decision === "" ? null : r.policy_decision,
    correlationKey: r.correlation_key,
  }));
export type AccessRequestRecord = z.output<typeof AccessRequestRecordSchema>;

export const ListEnvelopeSchema = z.object({ result: z.array(z.unknown()) });
export const SingleEnvelopeSchema = z.object({ result: z.record(z.string(), z.unknown()) });

/** Filters are combined with AND. Values are validated so they cannot alter the encoded query. */
export const AccessRequestQuerySchema = z.object({
  employeeId: z.string().min(1).max(255).optional(),
  workflowId: z.string().min(1).max(255).optional(),
  correlationKey: z.string().min(1).max(255).optional(),
  limit: z.int().min(1).max(1000).default(100),
  offset: z.int().min(0).default(0),
});
export type AccessRequestQuery = z.input<typeof AccessRequestQuerySchema>;

export const TableObjectSchema = z.object({
  name: z.string(),
  label: z.string(),
  "super_class.name": z.string(),
  "sys_scope.scope": z.string(),
});
export const DictionaryEntrySchema = z.object({
  element: z.string(),
  internal_type: z.string(),
  max_length: z.string(),
  mandatory: z.string(),
  unique: z.string(),
  default_value: z.string(),
});
export const ChoiceEntrySchema = z.object({
  element: z.string(),
  value: z.string(),
  label: z.string(),
  inactive: z.string(),
});
