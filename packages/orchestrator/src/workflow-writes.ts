// Internal write helpers shared by the orchestrator's services. Not exported from the package:
// every caller must already be inside a transaction it owns.
import {
  auditEvents,
  employees,
  onboardingWorkflows,
  workflowSteps,
  type Employee,
  type OnboardingWorkflow,
  type Transaction,
} from "@aoo/db";
import type { WorkflowState } from "@aoo/shared";
import { and, count, eq, isNull, sql } from "drizzle-orm";

export interface EmployeeFields {
  hrisEmployeeId: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Inserts or refreshes the employee. Also row-locks it until the transaction ends. */
export async function upsertEmployee(tx: Transaction, fields: EmployeeFields): Promise<Employee> {
  const [employee] = await tx
    .insert(employees)
    .values(fields)
    .onConflictDoUpdate({
      target: employees.hrisEmployeeId,
      set: {
        email: fields.email,
        firstName: fields.firstName,
        lastName: fields.lastName,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!employee) throw new Error("employee upsert returned no row");
  return employee;
}

/** Creates a workflow in RECEIVED with its first step and a workflow.created audit event. */
export async function insertWorkflow(
  tx: Transaction,
  params: {
    employee: Employee;
    actor: string;
    correlationId: string | null;
    auditPayload?: Record<string, unknown>;
  },
): Promise<OnboardingWorkflow> {
  const { employee } = params;
  const [workflow] = await tx
    .insert(onboardingWorkflows)
    .values({ employeeId: employee.id })
    .returning();
  if (!workflow) throw new Error("workflow insert returned no row");

  await startStep(tx, workflow.id, workflow.state);
  await tx.insert(auditEvents).values({
    workflowId: workflow.id,
    eventType: "workflow.created",
    actor: params.actor,
    toState: workflow.state,
    workflowVersion: workflow.version,
    correlationId: params.correlationId,
    payload: {
      employeeId: employee.id,
      hrisEmployeeId: employee.hrisEmployeeId,
      ...params.auditPayload,
    },
  });

  return workflow;
}

/** Opens the phase step for `state`; re-entering a phase (e.g. approval loops) bumps attempt. */
export async function startStep(tx: Transaction, workflowId: string, state: WorkflowState) {
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
