import { WORKFLOW_STATES } from "@aoo/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  hrisEmployeeId: text("hris_employee_id").notNull().unique(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  ...timestamps,
});

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

export type HrisEventReceipt = typeof hrisEventReceipts.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type OutboxEventAttempt = typeof outboxEventAttempts.$inferSelect;
export type ExternalOperation = typeof externalOperations.$inferSelect;
