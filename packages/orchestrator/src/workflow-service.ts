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
import type { WorkflowState } from "@aoo/shared";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { WorkflowNotFoundError, WorkflowVersionConflictError } from "./errors.js";
import {
  CreateWorkflowInputSchema,
  TransitionInputSchema,
  type CreateWorkflowInput,
  type TransitionInput,
} from "./schemas.js";
import { assertTransition, isTerminal } from "./state-machine.js";

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
  transition(input: TransitionInput): Promise<OnboardingWorkflow>;
  listAuditEvents(workflowId: string): Promise<AuditEvent[]>;
}

const WorkflowIdSchema = z.uuid();

export function createWorkflowService(db: Database): WorkflowService {
  return {
    async createWorkflow(rawInput) {
      const input = CreateWorkflowInputSchema.parse(rawInput);

      return db.transaction(async (tx) => {
        const [employee] = await tx
          .insert(employees)
          .values(input.employee)
          .onConflictDoUpdate({
            target: employees.hrisEmployeeId,
            set: {
              email: input.employee.email,
              firstName: input.employee.firstName,
              lastName: input.employee.lastName,
              updatedAt: sql`now()`,
            },
          })
          .returning();
        if (!employee) throw new Error("employee upsert returned no row");

        const [workflow] = await tx
          .insert(onboardingWorkflows)
          .values({ employeeId: employee.id })
          .returning();
        if (!workflow) throw new Error("workflow insert returned no row");

        await startStep(tx, workflow.id, workflow.state);
        await tx.insert(auditEvents).values({
          workflowId: workflow.id,
          eventType: "workflow.created",
          actor: input.actor,
          toState: workflow.state,
          workflowVersion: workflow.version,
          correlationId: input.correlationId ?? null,
          payload: { employeeId: employee.id, hrisEmployeeId: employee.hrisEmployeeId },
        });

        return workflow;
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

    async transition(rawInput) {
      const input = TransitionInputSchema.parse(rawInput);

      return db.transaction(async (tx) => {
        // Row lock serializes concurrent transitions; the version check then rejects the loser.
        const [current] = await tx
          .select()
          .from(onboardingWorkflows)
          .where(eq(onboardingWorkflows.id, input.workflowId))
          .for("update");
        if (!current) throw new WorkflowNotFoundError(input.workflowId);
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
          payload: {
            ...(input.reason !== undefined && { reason: input.reason }),
            ...(current.state === "POLICY_REVIEW" &&
              input.to === "PROVISIONING" && { approvalSkipped: true }),
          },
        });

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

/** Opens the phase step for `state`; re-entering a phase (e.g. approval loops) bumps attempt. */
async function startStep(tx: Transaction, workflowId: string, state: WorkflowState) {
  const [previous] = await tx
    .select({ n: count() })
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.workflowId, workflowId),
        eq(workflowSteps.stepKey, state),
        isNull(workflowSteps.subjectKey),
      ),
    );
  await tx.insert(workflowSteps).values({
    workflowId,
    stepKey: state,
    status: "RUNNING",
    attempt: (previous?.n ?? 0) + 1,
  });
}
