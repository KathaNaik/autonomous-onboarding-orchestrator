import {
  APPROVAL_STATUSES,
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  ROLE_FAMILY_CODES,
  WORKFLOW_STATES,
} from "@aoo/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workflowStateEnum = pgEnum("workflow_state", WORKFLOW_STATES);

export const WORKFLOW_STEP_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;
export const workflowStepStatusEnum = pgEnum("workflow_step_status", WORKFLOW_STEP_STATUSES);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ")})`);

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hrisEmployeeId: text("hris_employee_id").notNull().unique(),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    // Canonical facts (M5C), authoritative from HRIS. NULL only on rows created before M5C (or
    // outside HRIS intake); such employees can't produce a policy subject.
    departmentCode: text("department_code"),
    roleFamilyCode: text("role_family_code"),
    employmentType: text("employment_type"),
    /** The HRIS event whose facts are stored (the latest accepted event for this employee). */
    factsHrisEventId: text("facts_hris_event_id"),
    ...timestamps,
  },
  (t) => [
    check(
      "employees_canonical_facts_all_or_none",
      sql`(${t.departmentCode} IS NULL AND ${t.roleFamilyCode} IS NULL AND ${t.employmentType} IS NULL AND ${t.factsHrisEventId} IS NULL) OR (${t.departmentCode} IS NOT NULL AND ${t.roleFamilyCode} IS NOT NULL AND ${t.employmentType} IS NOT NULL AND ${t.factsHrisEventId} IS NOT NULL)`,
    ),
    check(
      "employees_department_code_valid",
      sql`${t.departmentCode} IN ${inList(DEPARTMENT_CODES)}`,
    ),
    check(
      "employees_role_family_code_valid",
      sql`${t.roleFamilyCode} IN ${inList(ROLE_FAMILY_CODES)}`,
    ),
    check(
      "employees_employment_type_valid",
      sql`${t.employmentType} IN ${inList(EMPLOYMENT_TYPE_CODES)}`,
    ),
  ],
);

export const onboardingWorkflows = pgTable(
  "onboarding_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    state: workflowStateEnum("state").notNull().default("RECEIVED"),
    // Optimistic concurrency token: incremented by every transition.
    version: integer("version").notNull().default(1),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("onboarding_workflows_employee_id_idx").on(t.employeeId),
    index("onboarding_workflows_state_idx").on(t.state),
    check("onboarding_workflows_version_positive", sql`${t.version} >= 1`),
    check(
      "onboarding_workflows_failure_reason_iff_failed",
      sql`(${t.state} = 'FAILED') = (${t.failureReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * A unit of work within a workflow. In M2 each workflow phase is one step
 * (step_key = state, subject_key = NULL). Later milestones add per-resource steps by setting
 * subject_key (e.g. a catalog entitlement), each with its own independent status.
 */
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    stepKey: text("step_key").notNull(),
    subjectKey: text("subject_key"),
    status: workflowStepStatusEnum("status").notNull(),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workflow_steps_workflow_id_idx").on(t.workflowId),
    // At most one open step per (workflow, step, subject).
    uniqueIndex("workflow_steps_one_running_idx")
      .on(t.workflowId, t.stepKey, sql`coalesce(${t.subjectKey}, '')`)
      .where(sql`${t.status} = 'RUNNING'`),
    check("workflow_steps_attempt_positive", sql`${t.attempt} >= 1`),
  ],
);

/** Append-only: UPDATE, DELETE and TRUNCATE are rejected by database triggers. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").references(() => onboardingWorkflows.id, {
      onDelete: "restrict",
    }),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    fromState: workflowStateEnum("from_state"),
    toState: workflowStateEnum("to_state"),
    workflowVersion: integer("workflow_version"),
    correlationId: text("correlation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Set on transitions that must happen at most once (e.g. "workflow-start:<id>"). */
    idempotencyKey: text("idempotency_key"),
    // clock_timestamp(), not now(): now() is the transaction start, which misorders events
    // written by concurrent transactions that commit in a different order than they began.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    index("audit_events_workflow_id_idx").on(t.workflowId, t.workflowVersion),
    uniqueIndex("audit_events_idempotency_key_idx")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

export type Employee = typeof employees.$inferSelect;
export type OnboardingWorkflow = typeof onboardingWorkflows.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

/**
 * One row per accepted HRIS event. event_id is the HRIS-assigned id and is unique, which makes
 * redelivery idempotent. payload_sha256 detects a reused event_id carrying different content.
 */
export const hrisEventReceipts = pgTable(
  "hris_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    hrisEmployeeId: text("hris_employee_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    workflowCreated: boolean("workflow_created").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hris_event_receipts_workflow_id_idx").on(t.workflowId)],
);

export const OUTBOX_STATUSES = ["PENDING", "PROCESSED", "DEAD_LETTERED"] as const;
export const outboxStatusEnum = pgEnum("outbox_status", OUTBOX_STATUSES);

/**
 * Transactional outbox: rows are written in the same transaction as the state change they
 * describe, then claimed and processed by the outbox worker.
 *
 * Lifecycle: PENDING → PROCESSED, or PENDING → (retries) → DEAD_LETTERED → (manual redrive) → PENDING.
 * A PENDING row is claimed by setting a lease (lease_token/owner/expires_at). A lease that has
 * expired may be reclaimed by another worker, and completion is fenced on lease_token plus an
 * unexpired lease, so a stale worker can never acknowledge or fail an event it no longer holds.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    correlationId: text("correlation_id"),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the event was successfully delivered (locally: its handler succeeded). */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Total claims ever made; numbers outbox_event_attempts. Never reset. */
    attempts: integer("attempts").notNull().default(0),
    /** Claims since creation or the last redrive; compared against the retry limit. */
    cycleAttempts: integer("cycle_attempts").notNull().default(0),
    lastError: text("last_error"),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    redriveCount: integer("redrive_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_events_claimable_idx")
      .on(t.availableAt)
      .where(sql`${t.status} = 'PENDING'`),
    index("outbox_events_aggregate_idx").on(t.aggregateType, t.aggregateId),
    check("outbox_events_attempts_non_negative", sql`${t.attempts} >= 0`),
    check(
      "outbox_events_cycle_attempts_valid",
      sql`${t.cycleAttempts} >= 0 AND ${t.cycleAttempts} <= ${t.attempts}`,
    ),
    check(
      "outbox_events_published_iff_processed",
      sql`(${t.status} = 'PROCESSED') = (${t.publishedAt} IS NOT NULL)`,
    ),
    check(
      "outbox_events_dead_lettered_iff_status",
      sql`(${t.status} = 'DEAD_LETTERED') = (${t.deadLetteredAt} IS NOT NULL)`,
    ),
    check(
      "outbox_events_lease_all_or_nothing",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseOwner} IS NULL) AND (${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "outbox_events_lease_only_when_pending",
      sql`${t.leaseToken} IS NULL OR ${t.status} = 'PENDING'`,
    ),
  ],
);

export const OUTBOX_ATTEMPT_OUTCOMES = [
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTERED",
  "LEASE_EXPIRED",
] as const;
export const outboxAttemptOutcomeEnum = pgEnum("outbox_attempt_outcome", OUTBOX_ATTEMPT_OUTCOMES);

/**
 * One row per claim of an outbox event: who held it, until when, and how it ended. outcome is
 * NULL while the attempt is in flight; a reclaim after lease expiry closes it as LEASE_EXPIRED.
 */
export const outboxEventAttempts = pgTable(
  "outbox_event_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    leaseToken: uuid("lease_token").notNull().unique(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: outboxAttemptOutcomeEnum("outcome"),
    error: text("error"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("outbox_event_attempts_event_attempt_idx").on(t.outboxEventId, t.attemptNumber),
    check(
      "outbox_event_attempts_outcome_iff_finished",
      sql`(${t.outcome} IS NULL) = (${t.finishedAt} IS NULL)`,
    ),
  ],
);

export const EXTERNAL_PROVIDERS = ["servicenow", "okta", "github"] as const;
export const externalProviderEnum = pgEnum("external_provider", EXTERNAL_PROVIDERS);

/**
 * PENDING          created, never attempted, or a previous attempt provably did not reach the provider
 * IN_PROGRESS      owned by one worker (owner_token + unexpired owner_expires_at)
 * OUTCOME_UNKNOWN  a write may have reached the provider; any next attempt must reconcile first
 * SUCCEEDED        verified by provider read-back (terminal)
 * FAILED           stopped: permanent error (auth, permission, validation); reopen manually
 * CONFLICT         stopped: provider state contradicts the request; evidence preserved
 */
export const EXTERNAL_OPERATION_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "OUTCOME_UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "CONFLICT",
] as const;
export const externalOperationStatusEnum = pgEnum(
  "external_operation_status",
  EXTERNAL_OPERATION_STATUSES,
);

/**
 * Durable record of one logical external side effect (e.g. "create the ServiceNow access request
 * for workflow W, resource R"). Persisted before the provider is called; the provider-side
 * correlation_key makes the effect idempotent at the provider as well.
 */
export const externalOperations = pgTable(
  "external_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    provider: externalProviderEnum("provider").notNull(),
    operationType: text("operation_type").notNull(),
    /** Local logical identity of the side effect; one row per logical operation. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** Deterministic provider-side key (ServiceNow correlation_key). */
    correlationKey: text("correlation_key").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    requestSha256: text("request_sha256").notNull(),
    status: externalOperationStatusEnum("status").notNull().default("PENDING"),
    /** Provider record id (ServiceNow sys_id) once known. */
    externalId: text("external_id"),
    /** Human-facing provider reference (ServiceNow ticket number) once known. */
    externalReference: text("external_reference"),
    attempts: integer("attempts").notNull().default(0),
    /** Sanitized; never contains credentials or request payload values. */
    lastError: text("last_error"),
    lastErrorDetail: jsonb("last_error_detail").$type<Record<string, unknown>>(),
    /** Provider evidence captured when stopping with CONFLICT. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    ownerToken: uuid("owner_token"),
    ownerId: text("owner_id"),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("external_operations_provider_correlation_idx").on(t.provider, t.correlationKey),
    index("external_operations_workflow_id_idx").on(t.workflowId),
    index("external_operations_status_idx").on(t.status),
    check("external_operations_attempts_non_negative", sql`${t.attempts} >= 0`),
    check(
      "external_operations_owner_all_or_nothing",
      sql`(${t.ownerToken} IS NULL) = (${t.ownerId} IS NULL) AND (${t.ownerToken} IS NULL) = (${t.ownerExpiresAt} IS NULL)`,
    ),
    check(
      "external_operations_owner_only_while_active",
      sql`${t.ownerToken} IS NULL OR ${t.status} IN ('IN_PROGRESS', 'OUTCOME_UNKNOWN')`,
    ),
    check(
      "external_operations_in_progress_has_owner",
      sql`${t.status} <> 'IN_PROGRESS' OR ${t.ownerToken} IS NOT NULL`,
    ),
    check(
      "external_operations_succeeded_is_complete",
      sql`${t.status} <> 'SUCCEEDED' OR (${t.externalId} IS NOT NULL AND ${t.externalReference} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const approvalStatusEnum = pgEnum("approval_status", APPROVAL_STATUSES);

/**
 * One human approval per external operation (i.e. per requested resource). Decided exactly once:
 * PENDING → APPROVED | REJECTED, only after the provider record was read back and verified.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    externalOperationId: uuid("external_operation_id")
      .notNull()
      .unique()
      .references(() => externalOperations.id, { onDelete: "restrict" }),
    provider: externalProviderEnum("provider").notNull(),
    correlationKey: text("correlation_key").notNull(),
    /** Provider record id (ServiceNow sys_id). */
    externalId: text("external_id").notNull(),
    externalReference: text("external_reference").notNull(),
    status: approvalStatusEnum("status").notNull().default("PENDING"),
    /** Raw provider value last verified by read-back (e.g. "approved"). */
    providerState: text("provider_state"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The callback event whose verification decided this approval. */
    decidedByEventId: text("decided_by_event_id"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("approvals_provider_correlation_idx").on(t.provider, t.correlationKey),
    index("approvals_workflow_id_idx").on(t.workflowId),
    check(
      "approvals_decided_consistency",
      sql`(${t.status} = 'PENDING') = (${t.decidedAt} IS NULL) AND (${t.status} = 'PENDING') = (${t.decidedByEventId} IS NULL)`,
    ),
    check("approvals_version_positive", sql`${t.version} >= 1`),
  ],
);

export const CALLBACK_EVENT_STATUSES = ["RECEIVED", "PROCESSED", "REJECTED"] as const;
export const callbackEventStatusEnum = pgEnum("callback_event_status", CALLBACK_EVENT_STATUSES);

/**
 * Durable inbox of provider approval callbacks. (provider, event_id) is unique: a replayed or
 * retried delivery can never be applied twice. Stores identifiers only (no raw body, headers or
 * employee data); `outcome` records what verification concluded.
 */
export const approvalCallbackEvents = pgTable(
  "approval_callback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: externalProviderEnum("provider").notNull(),
    eventId: text("event_id").notNull(),
    externalId: text("external_id").notNull(),
    externalReference: text("external_reference").notNull(),
    correlationKey: text("correlation_key").notNull(),
    /** Sender's claim; diagnostic only, never used for decisions. */
    claimedState: text("claimed_state"),
    payloadSha256: text("payload_sha256").notNull(),
    status: callbackEventStatusEnum("status").notNull().default("RECEIVED"),
    /** e.g. APPLIED_APPROVED, ALREADY_APPLIED, STILL_PENDING, UNKNOWN_TICKET, IDENTITY_MISMATCH. */
    outcome: text("outcome"),
    outcomeDetail: jsonb("outcome_detail").$type<Record<string, unknown>>(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "restrict" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("approval_callback_events_provider_event_idx").on(t.provider, t.eventId),
    index("approval_callback_events_correlation_idx").on(t.provider, t.correlationKey),
    check(
      "approval_callback_events_processed_consistency",
      sql`(${t.status} = 'RECEIVED') = (${t.processedAt} IS NULL)`,
    ),
  ],
);

export const AGENT_RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;
export const agentRunStatusEnum = pgEnum("agent_run_status", AGENT_RUN_STATUSES);

/**
 * One logical recommendation attempt by an agent (M6A: the Role Access Agent). Unique by
 * logical_run_key, so retries, duplicate deliveries and restarts reuse the same row. Written only
 * by @aoo/orchestrator; agents never touch the database.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalRunKey: text("logical_run_key").notNull().unique(),
    /** e.g. "role-access". */
    agent: text("agent").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    promptVersion: text("prompt_version").notNull(),
    modelProvider: text("model_provider").notNull(),
    model: text("model").notNull(),
    /** Everything shaping model behavior besides the prompt (provider/model/sampling/limits). */
    modelConfig: text("model_config").notNull(),
    /** Model identifier the provider reported serving (may differ from the requested alias). */
    servedModel: text("served_model"),
    catalogVersion: text("catalog_version").notNull(),
    catalogHash: text("catalog_hash").notNull(),
    /** sha256 of the exact model-visible input (context + available resources). */
    inputHash: text("input_hash").notNull(),
    // Canonical employee-fact snapshot taken when the run started. Copied from HRIS-sourced
    // employee columns; never produced or modified by the model.
    departmentCode: text("department_code").notNull(),
    roleFamilyCode: text("role_family_code").notNull(),
    employmentType: text("employment_type").notNull(),
    factsHrisEventId: text("facts_hris_event_id").notNull(),
    status: agentRunStatusEnum("status").notNull(),
    /** Claims of this logical run (first run, retries after transient failure or crash). */
    attempts: integer("attempts").notNull().default(1),
    /** Model calls in the last claim, including transient retries. */
    modelCalls: integer("model_calls"),
    ownerToken: uuid("owner_token"),
    ownerId: text("owner_id"),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    recommendationCount: integer("recommendation_count"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Sanitized: category, message and optional ids only; never keys, headers or job text. */
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    errorRetryable: boolean("error_retryable"),
    errorDetail: jsonb("error_detail").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index("agent_runs_workflow_id_idx").on(t.workflowId),
    check("agent_runs_attempts_positive", sql`${t.attempts} >= 1`),
    check(
      "agent_runs_owner_all_or_nothing",
      sql`(${t.ownerToken} IS NULL) = (${t.ownerId} IS NULL) AND (${t.ownerToken} IS NULL) = (${t.ownerExpiresAt} IS NULL)`,
    ),
    check(
      "agent_runs_owner_iff_running",
      sql`(${t.status} = 'RUNNING') = (${t.ownerToken} IS NOT NULL)`,
    ),
    check(
      "agent_runs_succeeded_complete",
      sql`${t.status} <> 'SUCCEEDED' OR (${t.completedAt} IS NOT NULL AND ${t.recommendationCount} IS NOT NULL AND ${t.errorCategory} IS NULL)`,
    ),
    check(
      "agent_runs_failed_has_error",
      sql`${t.status} <> 'FAILED' OR (${t.completedAt} IS NOT NULL AND ${t.errorCategory} IS NOT NULL AND ${t.errorRetryable} IS NOT NULL)`,
    ),
    check(
      "agent_runs_department_code_valid",
      sql`${t.departmentCode} IN ${inList(DEPARTMENT_CODES)}`,
    ),
    check(
      "agent_runs_role_family_code_valid",
      sql`${t.roleFamilyCode} IN ${inList(ROLE_FAMILY_CODES)}`,
    ),
    check(
      "agent_runs_employment_type_valid",
      sql`${t.employmentType} IN ${inList(EMPLOYMENT_TYPE_CODES)}`,
    ),
  ],
);

/** Validated recommendations of a SUCCEEDED run, exactly as the agent produced them. */
export const agentRecommendations = pgTable(
  "agent_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    /** A resource of the run's catalog version (validated before insert). */
    resourceId: text("resource_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_recommendations_run_resource_idx").on(t.agentRunId, t.resourceId),
    check(
      "agent_recommendations_confidence_range",
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
  ],
);

export const ACCESS_DECISIONS = ["ALLOW", "DENY", "REQUIRES_APPROVAL"] as const;
export const accessDecisionEnum = pgEnum("access_decision", ACCESS_DECISIONS);

/**
 * One deterministic policy decision for one resource recommended by one agent run (M6B).
 * Append-only (a trigger rejects UPDATE and DELETE): a later policy or catalog release never
 * changes an existing decision. Every input that defined it is recorded alongside.
 */
export const accessDecisions = pgTable(
  "access_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 over the immutable inputs (run, resource, catalog, policy, fact snapshot). */
    logicalDecisionKey: text("logical_decision_key").notNull().unique(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    resourceId: text("resource_id").notNull(),
    catalogVersion: text("catalog_version").notNull(),
    catalogHash: text("catalog_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    // The canonical fact snapshot of the agent run, never the employee's current row.
    departmentCode: text("department_code").notNull(),
    roleFamilyCode: text("role_family_code").notNull(),
    employmentType: text("employment_type").notNull(),
    employeeFactsSourceEventId: text("employee_facts_source_event_id").notNull(),
    decision: accessDecisionEnum("decision").notNull(),
    matchedRuleId: text("matched_rule_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    explanation: text("explanation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One decision per recommended resource per agent run: an authorized run is never silently
    // re-authorized under another policy or catalog.
    uniqueIndex("access_decisions_run_resource_idx").on(t.agentRunId, t.resourceId),
    index("access_decisions_workflow_id_idx").on(t.workflowId),
  ],
);

export const ACCESS_REQUEST_STATUSES = [
  "READY_FOR_PROVISIONING",
  "DENIED",
  "AWAITING_APPROVAL",
  "REJECTED",
  // M7A provisioning lifecycle.
  "PROVISIONING",
  "PROVISIONED",
  "PROVISIONING_FAILED",
  // M7C: authorized, provider MANUAL: an operator must perform/confirm the external action.
  "MANUAL_ACTION_REQUIRED",
] as const;
export const accessRequestStatusEnum = pgEnum("access_request_status", ACCESS_REQUEST_STATUSES);
export const ACCESS_AUTHORIZED_VIA = ["POLICY", "APPROVAL"] as const;
/** M7C: how a non-settled resource is blocked (orchestration visibility, not authority). */
export const PROVISIONING_BLOCKER_CLASSES = [
  "WAITING",
  "RETRYABLE",
  "MANUAL",
  "DETERMINISTIC_FAILURE",
] as const;

/**
 * Per-resource lifecycle (M6B): the authority for one resource's state, independent of the
 * workflow's aggregate phase. One row per access decision. Nothing is provisioned in M6B.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    accessDecisionId: uuid("access_decision_id")
      .notNull()
      .unique()
      .references(() => accessDecisions.id, { onDelete: "restrict" }),
    resourceId: text("resource_id").notNull(),
    status: accessRequestStatusEnum("status").notNull(),
    /** How a READY_FOR_PROVISIONING resource was authorized. */
    authorizedVia: text("authorized_via"),
    /** The M4B ServiceNow ticket operation, for REQUIRES_APPROVAL decisions. */
    externalOperationId: uuid("external_operation_id")
      .unique()
      .references(() => externalOperations.id, { onDelete: "restrict" }),
    /** The M4C approval that decided this resource, once verified. */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "restrict" }),
    // M7A: verified provisioning evidence (provider ids only, no response bodies).
    /** The external operation that applied the entitlement (e.g. Okta group membership). */
    provisioningOperationId: uuid("provisioning_operation_id")
      .unique()
      .references(() => externalOperations.id, { onDelete: "restrict" }),
    /** Provider subject the entitlement was applied to (e.g. Okta user id). */
    providerSubjectId: text("provider_subject_id"),
    /** Provider target (e.g. Okta group id). */
    providerTargetId: text("provider_target_id"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    /** Stable error code for PROVISIONING_FAILED (never provider text). */
    provisioningErrorCode: text("provisioning_error_code"),
    /**
     * M7B: provider-side state while PROVISIONING (e.g. INVITATION_PENDING: GitHub sent an org
     * invitation the user has not accepted yet). Null otherwise.
     */
    providerState: text("provider_state"),
    /** M7B: small curated provider evidence (ids, logins, slugs); never API payloads. */
    providerEvidence: jsonb("provider_evidence").$type<Record<string, unknown>>(),
    // M7C: orchestration visibility. Why the coordinator couldn't settle this resource yet.
    /** Stable blocker code, e.g. GITHUB_INVITATION_PENDING, MISSING_AUTHORIZED_DEPENDENCY. */
    orchestrationBlocker: text("orchestration_blocker"),
    /** WAITING, RETRYABLE, MANUAL or DETERMINISTIC_FAILURE. */
    blockerClass: text("blocker_class"),
    /** When the periodic reconciler should look again (null: event-driven only). */
    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
    lastCoordinatedAt: timestamp("last_coordinated_at", { withTimezone: true }),
    /** M7C: operator who confirmed a MANUAL resource (audit actor `hr:<id>`). */
    manualCompletedBy: text("manual_completed_by"),
    /** M7C: short, safe operator evidence for a MANUAL resource (no credentials). */
    manualEvidence: text("manual_evidence"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("access_requests_workflow_id_idx").on(t.workflowId),
    index("access_requests_next_reconcile_idx")
      .on(t.nextReconcileAt)
      .where(sql`${t.nextReconcileAt} IS NOT NULL`),
    // Authorized resources keep their authorization through the provisioning lifecycle. The M7A
    // enum values are compared as text: PostgreSQL forbids using a new enum value in the
    // transaction that adds it, and migrations run in one transaction.
    check(
      "access_requests_authorized_via_iff_authorized",
      sql`(${t.status}::text IN ('READY_FOR_PROVISIONING', 'PROVISIONING', 'PROVISIONED', 'PROVISIONING_FAILED', 'MANUAL_ACTION_REQUIRED')) = (${t.authorizedVia} IS NOT NULL)`,
    ),
    check(
      "access_requests_provisioned_has_evidence",
      // Provider evidence, or (M7C, MANUAL resources) the operator's confirmation and evidence.
      sql`${t.status}::text <> 'PROVISIONED' OR (${t.provisionedAt} IS NOT NULL AND ((${t.provisioningOperationId} IS NOT NULL AND ${t.providerSubjectId} IS NOT NULL AND ${t.providerTargetId} IS NOT NULL) OR (${t.manualCompletedBy} IS NOT NULL AND ${t.manualEvidence} IS NOT NULL)))`,
    ),
    check(
      "access_requests_failed_has_code",
      sql`(${t.status}::text = 'PROVISIONING_FAILED') = (${t.provisioningErrorCode} IS NOT NULL)`,
    ),
    check(
      "access_requests_authorized_via_valid",
      sql`${t.authorizedVia} IS NULL OR ${t.authorizedVia} IN ${inList(ACCESS_AUTHORIZED_VIA)}`,
    ),
    check(
      "access_requests_approval_path",
      sql`${t.status} NOT IN ('AWAITING_APPROVAL', 'REJECTED') OR ${t.authorizedVia} IS NULL`,
    ),
    check(
      "access_requests_approved_has_approval",
      sql`${t.authorizedVia} IS DISTINCT FROM 'APPROVAL' OR ${t.approvalId} IS NOT NULL`,
    ),
    check(
      "access_requests_blocker_class_valid",
      sql`${t.blockerClass} IS NULL OR ${t.blockerClass} IN ${inList(PROVISIONING_BLOCKER_CLASSES)}`,
    ),
    check(
      "access_requests_blocker_pair",
      sql`(${t.orchestrationBlocker} IS NULL) = (${t.blockerClass} IS NULL)`,
    ),
    check(
      "access_requests_manual_evidence_pair",
      sql`(${t.manualCompletedBy} IS NULL) = (${t.manualEvidence} IS NULL)`,
    ),
  ],
);

/**
 * Provider identity links (M7A). One verified provider account per employee per provider, and a
 * provider account can belong to only one employee. Once linked, the immutable provider subject
 * id is used instead of searching again. Holds no credentials.
 */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    provider: externalProviderEnum("provider").notNull(),
    /** Immutable provider id (Okta user id). */
    providerSubjectId: text("provider_subject_id").notNull(),
    /** Safe provider identifier for humans (Okta login). */
    providerLogin: text("provider_login").notNull(),
    /** The external operation whose verified result established the link. */
    linkedByOperationId: uuid("linked_by_operation_id").references(() => externalOperations.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("external_identities_employee_provider_idx").on(t.employeeId, t.provider),
    uniqueIndex("external_identities_provider_subject_idx").on(t.provider, t.providerSubjectId),
  ],
);

/**
 * Trusted claims of an employee's provider account (M7B), e.g. the GitHub login supplied by HRIS
 * onboarding data. A claim is only a pointer: provisioning resolves it exactly at the provider
 * and links the immutable provider id in external_identities. One claim per employee/provider;
 * the latest accepted HRIS event wins.
 */
export const externalIdentityClaims = pgTable(
  "external_identity_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    provider: externalProviderEnum("provider").notNull(),
    /** The exact provider login HR/onboarding staff recorded (never inferred). */
    claimedLogin: text("claimed_login").notNull(),
    /**
     * Where the claim came from. "HR_INPUT" (since 0015): recorded by HR/onboarding staff. The
     * legacy "EMPLOYEE_INPUT" (0014, pre-commit only) is never written and is ignored (fail-closed).
     */
    source: text("source").notNull(),
    /** Unused since 0014 (HRIS no longer carries provider logins); kept nullable. */
    sourceEventId: text("source_event_id"),
    /** (0014) The onboarding workflow the claim was recorded for. */
    workflowId: uuid("workflow_id").references(() => onboardingWorkflows.id, {
      onDelete: "restrict",
    }),
    /** (0015) The HR/onboarding operator who last recorded the claim (self-declared id). */
    recordedBy: text("recorded_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("external_identity_claims_employee_provider_idx").on(t.employeeId, t.provider),
    check(
      "external_identity_claims_source_check",
      sql`${t.source} IN ('HR_INPUT', 'EMPLOYEE_INPUT')`,
    ),
  ],
);

export type ExternalIdentityClaim = typeof externalIdentityClaims.$inferSelect;
export type ExternalIdentity = typeof externalIdentities.$inferSelect;
export type AccessDecision = typeof accessDecisions.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type HrisEventReceipt = typeof hrisEventReceipts.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentRecommendation = typeof agentRecommendations.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type OutboxEventAttempt = typeof outboxEventAttempts.$inferSelect;
export type ExternalOperation = typeof externalOperations.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type ApprovalCallbackEvent = typeof approvalCallbackEvents.$inferSelect;

export const PROVISIONING_PLAN_STATUSES = ["ACTIVE", "COMPLETE"] as const;
export const provisioningPlanStatusEnum = pgEnum(
  "provisioning_plan_status",
  PROVISIONING_PLAN_STATUSES,
);

/**
 * M7C: the authorization run a workflow's provisioning executes. Locks the exact agent run (and
 * its catalog and policy versions/hashes) whose access_requests are provisioned, so requests from
 * other historical runs are never mixed in. At most one ACTIVE plan per workflow.
 */
export const workflowProvisioningPlans = pgTable(
  "workflow_provisioning_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    catalogVersion: text("catalog_version").notNull(),
    catalogHash: text("catalog_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    status: provisioningPlanStatusEnum("status").notNull().default("ACTIVE"),
    /** AUTHORIZATION (created with M6B's authorization-complete transition) or LEGACY_ADOPTION. */
    createdVia: text("created_via").notNull(),
    lastCoordinatedAt: timestamp("last_coordinated_at", { withTimezone: true }),
    /** Earliest next_reconcile_at of its requests: the periodic reconciler's index. */
    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_provisioning_plans_one_active_idx")
      .on(t.workflowId)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("workflow_provisioning_plans_workflow_run_idx").on(t.workflowId, t.agentRunId),
    index("workflow_provisioning_plans_next_reconcile_idx")
      .on(t.nextReconcileAt)
      .where(sql`${t.status} = 'ACTIVE'`),
    check(
      "workflow_provisioning_plans_completed_iff_complete",
      sql`(${t.status} = 'COMPLETE') = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      "workflow_provisioning_plans_created_via_valid",
      sql`${t.createdVia} IN ('AUTHORIZATION', 'LEGACY_ADOPTION')`,
    ),
  ],
);
export type WorkflowProvisioningPlan = typeof workflowProvisioningPlans.$inferSelect;

/**
 * M8: one logical Onboarding Plan Agent generation per workflow and exact input (unique
 * logical_run_key), so retries, duplicate deliveries, restarts and concurrent workers reuse one row.
 * Separate from agent_runs (whose Role-Access-specific columns stay untouched). Records exactly what
 * the model saw (input_snapshot) and which settled resources it was built from (resource_snapshot).
 * Written only by @aoo/orchestrator.
 */
export const onboardingPlanRuns = pgTable(
  "onboarding_plan_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalRunKey: text("logical_run_key").notNull().unique(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    provisioningPlanId: uuid("provisioning_plan_id")
      .notNull()
      .references(() => workflowProvisioningPlans.id, { onDelete: "restrict" }),
    /** The Role Access Agent run whose authorized resources were provisioned (the plan's run). */
    sourceAgentRunId: uuid("source_agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    promptVersion: text("prompt_version").notNull(),
    modelProvider: text("model_provider").notNull(),
    model: text("model").notNull(),
    modelConfig: text("model_config").notNull(),
    servedModel: text("served_model"),
    providerResponseId: text("provider_response_id"),
    catalogVersion: text("catalog_version").notNull(),
    catalogHash: text("catalog_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    /** sha256 of input_snapshot (canonical JSON). */
    inputHash: text("input_hash").notNull(),
    /** Exactly what the model received (human-readable labels and resources; no identifiers). */
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    /** Internal settled-resource snapshot (request/decision ids, status); never sent to the model. */
    resourceSnapshot: jsonb("resource_snapshot").$type<Record<string, unknown>[]>().notNull(),
    status: agentRunStatusEnum("status").notNull(),
    attempts: integer("attempts").notNull().default(1),
    modelCalls: integer("model_calls"),
    ownerToken: uuid("owner_token"),
    ownerId: text("owner_id"),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** SUCCEEDED: the validated structured output (identical to the accepted plan). */
    output: jsonb("output").$type<Record<string, unknown>>(),
    /** Sanitized: category, message and codes only; never keys, headers, prompts or model text. */
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    errorRetryable: boolean("error_retryable"),
    errorDetail: jsonb("error_detail").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index("onboarding_plan_runs_workflow_id_idx").on(t.workflowId),
    check("onboarding_plan_runs_attempts_positive", sql`${t.attempts} >= 1`),
    check(
      "onboarding_plan_runs_owner_all_or_nothing",
      sql`(${t.ownerToken} IS NULL) = (${t.ownerId} IS NULL) AND (${t.ownerToken} IS NULL) = (${t.ownerExpiresAt} IS NULL)`,
    ),
    check(
      "onboarding_plan_runs_owner_iff_running",
      sql`(${t.status} = 'RUNNING') = (${t.ownerToken} IS NOT NULL)`,
    ),
    check(
      "onboarding_plan_runs_succeeded_complete",
      sql`${t.status} <> 'SUCCEEDED' OR (${t.completedAt} IS NOT NULL AND ${t.output} IS NOT NULL AND ${t.errorCategory} IS NULL)`,
    ),
    check(
      "onboarding_plan_runs_failed_has_error",
      sql`${t.status} <> 'FAILED' OR (${t.completedAt} IS NOT NULL AND ${t.errorCategory} IS NOT NULL AND ${t.errorRetryable} IS NOT NULL)`,
    ),
  ],
);
export type OnboardingPlanRun = typeof onboardingPlanRuns.$inferSelect;

/**
 * M8: the accepted onboarding plan. At most one per workflow (unique workflow_id) and one per run;
 * append-only (triggers reject UPDATE, DELETE and TRUNCATE), written in the same transaction as the
 * run's success and ONBOARDING_GENERATION → COMPLETED.
 */
export const onboardingPlans = pgTable(
  "onboarding_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .unique()
      .references(() => onboardingWorkflows.id, { onDelete: "restrict" }),
    onboardingPlanRunId: uuid("onboarding_plan_run_id")
      .notNull()
      .unique()
      .references(() => onboardingPlanRuns.id, { onDelete: "restrict" }),
    provisioningPlanId: uuid("provisioning_plan_id")
      .notNull()
      .references(() => workflowProvisioningPlans.id, { onDelete: "restrict" }),
    promptVersion: text("prompt_version").notNull(),
    summary: text("summary").notNull(),
    tasks: jsonb("tasks").$type<Record<string, unknown>[]>().notNull(),
    taskCount: integer("task_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "onboarding_plans_task_count_range",
      sql`${t.taskCount} BETWEEN 3 AND 12 AND jsonb_array_length(${t.tasks}) = ${t.taskCount}`,
    ),
  ],
);
export type OnboardingPlan = typeof onboardingPlans.$inferSelect;
