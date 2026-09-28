import {
  auditEvents,
  employees,
  onboardingWorkflows,
  workflowSteps,
  type AuditEvent,
  type Database,
  type Employee,
  type OnboardingWorkflow,
  type Transaction,
  type WorkflowStep,
} from "@aoo/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  IdempotencyKeyConflictError,
  WorkflowNotFoundError,
  WorkflowVersionConflictError,
} from "./errors.js";
import {
  CreateWorkflowInputSchema,
  TransitionInputSchema,
  type CreateWorkflowInput,
  type TransitionInput,
} from "./schemas.js";
import { assertTransition, isTerminal } from "./state-machine.js";
import { insertWorkflow, startStep, upsertEmployee } from "./workflow-writes.js";

export interface WorkflowDetails {
  workflow: OnboardingWorkflow;
  employee: Employee;
  steps: WorkflowStep[];
}

export interface WorkflowService {
  createWorkflow(input: CreateWorkflowInput): Promise<OnboardingWorkflow>;
  getWorkflow(workflowId: string): Promise<WorkflowDetails | null>;
  /**
   * Validates and applies one transition. The state change, step bookkeeping and audit event
   * commit in a single transaction. Throws WorkflowVersionConflictError when expectedVersion is
   * stale, so concurrent callers never silently overwrite each other.
   */
  transition(input: TransitionInput, options?: TransitionOptions): Promise<OnboardingWorkflow>;
  listAuditEvents(workflowId: string): Promise<AuditEvent[]>;
}

export interface TransitionOptions {
  /**
   * (M7C) Extra writes committed atomically with the transition (e.g. a provisioning plan and its
   * wake event). Runs only when the transition is actually applied, never on an idempotent replay.
   * `updated` is the workflow after the transition.
   */
  effects?: (tx: Transaction, updated: OnboardingWorkflow) => Promise<void>;
}

const WorkflowIdSchema = z.uuid();

export function createWorkflowService(db: Database): WorkflowService {
  return {
    async createWorkflow(rawInput) {
      const input = CreateWorkflowInputSchema.parse(rawInput);

      return db.transaction(async (tx) => {
        const employee = await upsertEmployee(tx, input.employee);
        return insertWorkflow(tx, {
          employee,
          actor: input.actor,
          correlationId: input.correlationId ?? null,
        });
      });
    },

    async getWorkflow(rawWorkflowId) {
      const workflowId = WorkflowIdSchema.parse(rawWorkflowId);

      const [row] = await db
        .select({ workflow: onboardingWorkflows, employee: employees })
        .from(onboardingWorkflows)
        .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
        .where(eq(onboardingWorkflows.id, workflowId));
      if (!row) return null;

      const steps = await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowId, workflowId))
        .orderBy(asc(workflowSteps.startedAt), asc(workflowSteps.createdAt));

      return { ...row, steps };
    },

    async transition(rawInput, options = {}) {
      const input = TransitionInputSchema.parse(rawInput);

      return db.transaction(async (tx) => {
        // Row lock serializes concurrent transitions; the version check then rejects the loser.
        const [current] = await tx
          .select()
          .from(onboardingWorkflows)
          .where(eq(onboardingWorkflows.id, input.workflowId))
          .for("update");
        if (!current) throw new WorkflowNotFoundError(input.workflowId);
        // Replay check comes before the version check: a retry after a committed transition
        // carries a stale expectedVersion by definition. The row lock above makes this race-free.
        if (input.idempotencyKey !== undefined) {
          const [prior] = await tx
            .select({ workflowId: auditEvents.workflowId })
            .from(auditEvents)
            .where(eq(auditEvents.idempotencyKey, input.idempotencyKey));
          if (prior) {
            if (prior.workflowId !== current.id) {
              throw new IdempotencyKeyConflictError(input.idempotencyKey, current.id);
            }
            return current;
          }
        }
        if (current.version !== input.expectedVersion) {
          throw new WorkflowVersionConflictError(
            current.id,
            input.expectedVersion,
            current.version,
          );
        }
        assertTransition(current.state, input.to);

        const failed = input.to === "FAILED";
        const [updated] = await tx
          .update(onboardingWorkflows)
          .set({
            state: input.to,
            version: sql`${onboardingWorkflows.version} + 1`,
            failureReason: failed ? (input.reason ?? null) : null,
            completedAt: isTerminal(input.to) ? sql`now()` : null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(onboardingWorkflows.id, current.id),
              eq(onboardingWorkflows.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!updated) {
          throw new WorkflowVersionConflictError(current.id, input.expectedVersion, -1);
        }

        await tx
          .update(workflowSteps)
          .set({
            status: failed ? "FAILED" : "SUCCEEDED",
            error: failed ? (input.reason ?? null) : null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, current.id),
              eq(workflowSteps.stepKey, current.state),
              isNull(workflowSteps.subjectKey),
              eq(workflowSteps.status, "RUNNING"),
            ),
          );
        if (!isTerminal(input.to)) await startStep(tx, current.id, input.to);

        await tx.insert(auditEvents).values({
          workflowId: current.id,
          eventType: "workflow.transitioned",
          actor: input.actor,
          fromState: current.state,
          toState: input.to,
          workflowVersion: updated.version,
          correlationId: input.correlationId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          payload: {
            ...(input.reason !== undefined && { reason: input.reason }),
            ...(current.state === "POLICY_REVIEW" &&
              input.to === "PROVISIONING" && { approvalSkipped: true }),
          },
        });
        if (options.effects) await options.effects(tx, updated);

        return updated;
      });
    },

    async listAuditEvents(rawWorkflowId) {
      const workflowId = WorkflowIdSchema.parse(rawWorkflowId);
      return db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.workflowId, workflowId))
        .orderBy(asc(auditEvents.workflowVersion), asc(auditEvents.occurredAt));
    },
  };
}
