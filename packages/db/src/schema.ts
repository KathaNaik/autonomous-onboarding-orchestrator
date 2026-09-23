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
    // clock_timestamp(), not now(): now() is the transaction start, which misorders events
    // written by concurrent transactions that commit in a different order than they began.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [index("audit_events_workflow_id_idx").on(t.workflowId, t.workflowVersion)],
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

/**
 * Transactional outbox: rows are written in the same transaction as the state change they
 * describe and published later by a dispatcher (M3B). idempotency_key is unique per logical event.
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
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_events_unpublished_idx")
      .on(t.availableAt)
      .where(sql`${t.publishedAt} IS NULL`),
    index("outbox_events_aggregate_idx").on(t.aggregateType, t.aggregateId),
    check("outbox_events_attempts_non_negative", sql`${t.attempts} >= 0`),
  ],
);

export type HrisEventReceipt = typeof hrisEventReceipts.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
