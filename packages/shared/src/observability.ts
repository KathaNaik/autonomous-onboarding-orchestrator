import { z } from "zod";
import { WORKFLOW_STATES } from "./workflow.js";

/**
 * M9 operator read models: explicit, safe DTOs for the internal dashboard and its read-only API.
 * Every field is listed here; no database row is ever returned as-is, so a new column can't leak.
 * Nothing in these contracts carries credentials, raw provider or HRIS payloads, headers or
 * signatures.
 */

const iso = z.string(); // ISO 8601 timestamp
const nullableIso = iso.nullable();
const id = z.string().max(200);

/** Safe scalar details (whitelisted keys, sanitized and length-capped strings). */
export const SafeDetailsSchema = z.record(
  z.string(),
  z.union([z.string().max(300), z.number(), z.boolean(), z.null()]),
);

export const ONBOARDING_PLAN_READ_STATUSES = [
  "NOT_STARTED",
  "GENERATING",
  "FAILED",
  "ACCEPTED",
] as const;

export const ResourceProgressSchema = z.object({
  total: z.number().int(),
  settled: z.number().int(),
  provisioned: z.number().int(),
  denied: z.number().int(),
  rejected: z.number().int(),
  inProgress: z.number().int(),
  failed: z.number().int(),
});

export const BlockerSummarySchema = z.object({
  resourceId: id,
  /** (M13 UI) Catalog display name from the plan's exact release, when resolvable. */
  displayName: z.string().nullable(),
  status: z.string(),
  blocker: z.string().nullable(),
  blockerClass: z.string().nullable(),
});

export const EmployeeFactsViewSchema = z.object({
  departmentCode: z.string(),
  roleFamilyCode: z.string(),
  employmentType: z.string(),
});

export const WorkflowSummarySchema = z.object({
  workflowId: z.uuid(),
  state: z.enum(WORKFLOW_STATES),
  employee: z.object({
    hrisEmployeeId: id,
    displayName: z.string().max(300),
    /** (M13 UI) Job title display text from the facts-supplying receipt, when present. */
    jobTitle: z.string().max(300).nullable(),
    facts: EmployeeFactsViewSchema.nullable(),
  }),
  createdAt: iso,
  updatedAt: iso,
  completedAt: nullableIso,
  failureReason: z.string().max(500).nullable(),
  provisioningPlanStatus: z.enum(["ACTIVE", "COMPLETE"]).nullable(),
  onboardingPlanStatus: z.enum(ONBOARDING_PLAN_READ_STATUSES),
  resourceProgress: ResourceProgressSchema,
  /** Unresolved resources (at most 5), for the list's blocker summary. */
  blockers: z.array(BlockerSummarySchema).max(5),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

/**
 * (M13 UI) What makes a workflow "need attention": an unsettled resource of its current plan that
 * waits on a person (approver, fulfiller, HR, operator) or failed deterministically, or a FAILED
 * workflow. Shared by the read model's counts and the console's per-row summaries.
 */
export const ATTENTION_REQUEST_STATUSES = [
  "AWAITING_APPROVAL",
  "MANUAL_ACTION_REQUIRED",
  "PROVISIONING_FAILED",
] as const;
export const ATTENTION_BLOCKERS = [
  "GITHUB_IDENTITY_CLAIM_REQUIRED",
  "GITHUB_INVITATION_PENDING",
  "SERVICENOW_FULFILLMENT_PENDING",
  "SERVICENOW_FULFILLMENT_IN_PROGRESS",
] as const;
export const ATTENTION_BLOCKER_CLASSES = ["MANUAL", "DETERMINISTIC_FAILURE"] as const;

export const WorkflowListSummarySchema = z.object({
  total: z.number().int(),
  inProgress: z.number().int(),
  needsAttention: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});

export const WorkflowListResponseSchema = z.object({
  items: z.array(WorkflowSummarySchema),
  /** (M13 UI) Counts over all workflows (not just this page or filter). */
  summary: WorkflowListSummarySchema,
  /** Opaque keyset cursor for the next page (updated_at DESC, id DESC), or null. */
  nextCursor: z.string().max(200).nullable(),
});
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;

export const WorkflowListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  state: z.enum(WORKFLOW_STATES).optional(),
  /** (M13 UI) Case-insensitive search: employee name, work email, HRIS id or workflow id prefix. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;

const RecommendationViewSchema = z.object({
  resourceId: id,
  displayName: z.string().nullable(),
  reasonCode: z.string(),
  reason: z.string().max(500),
  confidence: z.number(),
});

const SafeErrorSchema = z.object({
  category: z.string(),
  message: z.string().max(500),
  retryable: z.boolean().nullable(),
});

export const RoleAccessRunViewSchema = z.object({
  agentRunId: z.uuid(),
  status: z.string(),
  promptVersion: z.string(),
  modelProvider: z.string(),
  model: z.string(),
  servedModel: z.string().nullable(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  attempts: z.number().int(),
  modelCalls: z.number().int().nullable(),
  startedAt: iso,
  completedAt: nullableIso,
  latencyMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  error: SafeErrorSchema.nullable(),
  recommendations: z.array(RecommendationViewSchema),
  /** Other Role Access runs of the workflow (e.g. after a fact change). */
  otherRunCount: z.number().int(),
});

export const PolicyDecisionViewSchema = z.object({
  accessDecisionId: z.uuid(),
  resourceId: id,
  displayName: z.string().nullable(),
  decision: z.enum(["ALLOW", "DENY", "REQUIRES_APPROVAL"]),
  policyVersion: z.string(),
  policyHash: z.string(),
  catalogVersion: z.string(),
  matchedRuleId: z.string(),
  reasonCode: z.string(),
  explanation: z.string().max(1000),
  decidedAt: iso,
});

export const ProvisioningPlanViewSchema = z.object({
  planId: z.uuid(),
  status: z.enum(["ACTIVE", "COMPLETE"]),
  createdVia: z.string(),
  agentRunId: z.uuid(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  policyVersion: z.string(),
  policyHash: z.string(),
  createdAt: iso,
  completedAt: nullableIso,
  lastCoordinatedAt: nullableIso,
  nextReconcileAt: nullableIso,
});

export const RESOURCE_AUTHORIZATION_OUTCOMES = [
  "AUTHORIZED_BY_POLICY",
  "AUTHORIZED_BY_APPROVAL",
  "PENDING_APPROVAL",
  "DENIED_BY_POLICY",
  "REJECTED_BY_APPROVER",
] as const;

export const ResourceViewSchema = z.object({
  accessRequestId: z.uuid(),
  resourceId: id,
  displayName: z.string().nullable(),
  provider: z.string().nullable(),
  catalogVersion: z.string(),
  /** Authorization (policy + approval), kept separate from provisioning. */
  authorization: z.object({
    decision: z.enum(["ALLOW", "DENY", "REQUIRES_APPROVAL"]),
    outcome: z.enum(RESOURCE_AUTHORIZATION_OUTCOMES),
    via: z.string().nullable(),
  }),
  /** Provisioning lifecycle status of the access request. */
  status: z.string(),
  settled: z.boolean(),
  dependsOn: z.array(z.object({ resourceId: id, status: z.string().nullable() })),
  blocker: z.string().nullable(),
  blockerClass: z.string().nullable(),
  providerState: z.string().nullable(),
  lastCoordinatedAt: nullableIso,
  nextReconcileAt: nullableIso,
  provisionedAt: nullableIso,
  provisioningErrorCode: z.string().nullable(),
  /** Safe provider evidence already persisted (no API calls). */
  evidence: SafeDetailsSchema,
});

export const ApprovalViewSchema = z.object({
  approvalId: z.uuid(),
  resourceId: id.nullable(),
  accessRequestId: z.uuid().nullable(),
  externalOperationId: z.uuid(),
  ticketNumber: z.string().nullable(),
  sysId: z.string().nullable(),
  status: z.string(),
  providerState: z.string().nullable(),
  requestedAt: iso,
  verifiedAt: nullableIso,
  decidedAt: nullableIso,
  callbacks: z.object({
    received: z.number().int(),
    processed: z.number().int(),
    rejected: z.number().int(),
    lastOutcome: z.string().nullable(),
  }),
});

export const FulfillmentViewSchema = z.object({
  resourceId: id,
  accessRequestId: z.uuid(),
  externalOperationId: z.uuid().nullable(),
  operationStatus: z.string().nullable(),
  requestKind: z.literal("fulfillment"),
  ticketNumber: z.string().nullable(),
  sysId: z.string().nullable(),
  fulfillmentState: z.string().nullable(),
  requestedAt: nullableIso,
  /** Set only when the authoritative read-back said `fulfilled` (the resource is PROVISIONED). */
  verifiedFulfilledAt: nullableIso,
  localStatus: z.string(),
});

export const IdentityViewSchema = z.object({
  provider: z.string(),
  providerSubjectId: z.string(),
  login: z.string().nullable(),
  linkedAt: iso,
  verifiedAt: nullableIso,
});

export const ExternalOperationViewSchema = z.object({
  operationId: z.uuid(),
  provider: z.string(),
  operationType: z.string(),
  /** The logical idempotency key, shortened (never request payload data). */
  keySummary: z.string().max(120),
  correlationKey: z.string().max(200),
  status: z.string(),
  attempts: z.number().int(),
  externalReference: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  completedAt: nullableIso,
  lastError: z.string().max(500).nullable(),
  resourceId: id.nullable(),
  accessRequestId: z.uuid().nullable(),
});

export const OnboardingPlanRunViewSchema = z.object({
  runId: z.uuid(),
  status: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  servedModel: z.string().nullable(),
  attempts: z.number().int(),
  modelCalls: z.number().int().nullable(),
  startedAt: iso,
  completedAt: nullableIso,
  latencyMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  error: SafeErrorSchema.nullable(),
  otherRunCount: z.number().int(),
});

export const PLAN_PHASE_ORDER = ["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"] as const;

export const OnboardingPlanViewSchema = z.object({
  planId: z.uuid(),
  runId: z.uuid(),
  promptVersion: z.string(),
  servedModel: z.string().nullable(),
  createdAt: iso,
  summary: z.string().max(1000),
  taskCount: z.number().int(),
  phases: z.array(
    z.object({
      phase: z.string(),
      tasks: z.array(
        z.object({
          category: z.string(),
          title: z.string().max(200),
          instruction: z.string().max(1000),
          resources: z.array(z.object({ resourceId: id, displayName: z.string().nullable() })),
        }),
      ),
    }),
  ),
});

export const TIMELINE_SOURCES = ["HRIS", "AUDIT"] as const;

export const TimelineEntrySchema = z.object({
  /** `<source>:<uuid>`: stable, unique; the tie-breaker after occurredAt. */
  id: z.string(),
  source: z.enum(TIMELINE_SOURCES),
  occurredAt: iso,
  type: z.string(),
  label: z.string(),
  actor: z.string().nullable(),
  fromState: z.string().nullable(),
  toState: z.string().nullable(),
  details: SafeDetailsSchema,
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const CorrelationViewSchema = z.object({
  correlationIds: z.array(z.string()),
  traceIds: z.array(z.string()),
  outboxEvents: z.array(
    z.object({
      eventId: z.uuid(),
      eventType: z.string(),
      status: z.string(),
      attempts: z.number().int(),
      createdAt: iso,
      publishedAt: nullableIso,
      traceId: z.string().nullable(),
    }),
  ),
  providerCorrelationKeys: z.array(z.string()),
});

export const WorkflowObservabilityViewSchema = z.object({
  generatedAt: iso,
  workflow: z.object({
    workflowId: z.uuid(),
    state: z.enum(WORKFLOW_STATES),
    version: z.number().int(),
    createdAt: iso,
    updatedAt: iso,
    completedAt: nullableIso,
    failureReason: z.string().max(500).nullable(),
  }),
  employee: z.object({
    hrisEmployeeId: id,
    displayName: z.string().max(300),
    workEmail: z.string().max(320),
    facts: EmployeeFactsViewSchema.nullable(),
    factsSourceEventId: z.string().nullable(),
    jobTitle: z.string().max(300).nullable(),
    departmentDisplay: z.string().max(300).nullable(),
  }),
  hrisEvents: z.array(
    z.object({
      eventId: z.string(),
      eventType: z.string(),
      receivedAt: iso,
      workflowCreated: z.boolean(),
    }),
  ),
  roleAccessRun: RoleAccessRunViewSchema.nullable(),
  policyDecisions: z.array(PolicyDecisionViewSchema),
  provisioningPlan: ProvisioningPlanViewSchema.nullable(),
  resources: z.array(ResourceViewSchema),
  approvals: z.array(ApprovalViewSchema),
  fulfillments: z.array(FulfillmentViewSchema),
  identities: z.array(IdentityViewSchema),
  githubClaim: z
    .object({
      login: z.string(),
      source: z.string(),
      recordedBy: z.string().nullable(),
      recordedAt: iso,
    })
    .nullable(),
  externalOperations: z.array(ExternalOperationViewSchema),
  onboardingPlanRun: OnboardingPlanRunViewSchema.nullable(),
  onboardingPlan: OnboardingPlanViewSchema.nullable(),
  timeline: z.array(TimelineEntrySchema),
  correlation: CorrelationViewSchema,
  /** Human notes about historical/missing data (e.g. "No Role Access Agent run yet"). */
  notes: z.array(z.string()),
});
export type WorkflowObservabilityView = z.infer<typeof WorkflowObservabilityViewSchema>;

export const OBSERVABILITY_ERROR_CODES = [
  "OPERATOR_UNAUTHORIZED",
  "OPERATOR_ID_INVALID",
  "INVALID_QUERY",
  "INVALID_PAYLOAD",
  "WORKFLOW_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;
export const ObservabilityErrorResponseSchema = z.object({
  error: z.enum(OBSERVABILITY_ERROR_CODES),
  message: z.string(),
});
export type ObservabilityErrorResponse = z.infer<typeof ObservabilityErrorResponseSchema>;

/**
 * (M10) Operator session revocation (logout). The web server sends it after the operator logs
 * out; the API then rejects that session (`X-Operator-Session`) before any read or write.
 */
export const OPERATOR_SESSION_HEADER = "x-operator-session";
export const OperatorSessionRevokeRequestSchema = z.strictObject({
  sessionNonce: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type OperatorSessionRevokeRequest = z.infer<typeof OperatorSessionRevokeRequestSchema>;
export const OperatorSessionRevokeResponseSchema = z.object({ revoked: z.literal(true) });
