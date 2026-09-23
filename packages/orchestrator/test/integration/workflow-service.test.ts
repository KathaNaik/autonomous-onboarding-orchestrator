import { auditEvents, createDatabase, onboardingWorkflows, type DatabaseHandle } from "@aoo/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  InvalidTransitionError,
  WorkflowNotFoundError,
  WorkflowVersionConflictError,
  createWorkflowService,
  type WorkflowService,
} from "../../src/index.js";
import { newEmployee } from "./helpers.js";

let handle: DatabaseHandle;
let service: WorkflowService;

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  service = createWorkflowService(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function createAt(...path: Parameters<WorkflowService["transition"]>[0]["to"][]) {
  let wf = await service.createWorkflow({ employee: newEmployee(), actor: "test" });
  for (const to of path) {
    wf = await service.transition({
      workflowId: wf.id,
      to,
      expectedVersion: wf.version,
      actor: "test",
    });
  }
  return wf;
}

describe("createWorkflow", () => {
  it("persists employee, workflow, first step and a created audit event", async () => {
    const employee = newEmployee();
    const wf = await service.createWorkflow({ employee, actor: "hris", correlationId: "corr-1" });

    expect(wf).toMatchObject({ state: "RECEIVED", version: 1, failureReason: null });
    const details = await service.getWorkflow(wf.id);
    expect(details?.employee).toMatchObject(employee);
    expect(details?.steps).toMatchObject([{ stepKey: "RECEIVED", status: "RUNNING", attempt: 1 }]);
    expect(await service.listAuditEvents(wf.id)).toMatchObject([
      {
        eventType: "workflow.created",
        actor: "hris",
        toState: "RECEIVED",
        workflowVersion: 1,
        correlationId: "corr-1",
      },
    ]);
  });

  it("reuses the employee record for the same HRIS id", async () => {
    const employee = newEmployee();
    const a = await service.createWorkflow({ employee, actor: "test" });
    const b = await service.createWorkflow({
      employee: { ...employee, email: "changed@example.com" },
      actor: "test",
    });
    expect(b.employeeId).toBe(a.employeeId);
    expect((await service.getWorkflow(a.id))?.employee.email).toBe("changed@example.com");
  });
});

describe("transition", () => {
  it("runs the approval path to COMPLETED with steps and audit trail", async () => {
    const wf = await createAt(
      "ACCESS_PLANNING",
      "POLICY_REVIEW",
      "AWAITING_APPROVAL",
      "PROVISIONING",
      "ONBOARDING_GENERATION",
      "COMPLETED",
    );

    expect(wf).toMatchObject({ state: "COMPLETED", version: 7 });
    expect(wf.completedAt).toBeInstanceOf(Date);
    const details = await service.getWorkflow(wf.id);
    expect(details?.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ["RECEIVED", "SUCCEEDED"],
      ["ACCESS_PLANNING", "SUCCEEDED"],
      ["POLICY_REVIEW", "SUCCEEDED"],
      ["AWAITING_APPROVAL", "SUCCEEDED"],
      ["PROVISIONING", "SUCCEEDED"],
      ["ONBOARDING_GENERATION", "SUCCEEDED"],
    ]);
    const audit = await service.listAuditEvents(wf.id);
    expect(audit.map((e) => [e.fromState, e.toState, e.workflowVersion])).toEqual([
      [null, "RECEIVED", 1],
      ["RECEIVED", "ACCESS_PLANNING", 2],
      ["ACCESS_PLANNING", "POLICY_REVIEW", 3],
      ["POLICY_REVIEW", "AWAITING_APPROVAL", 4],
      ["AWAITING_APPROVAL", "PROVISIONING", 5],
      ["PROVISIONING", "ONBOARDING_GENERATION", 6],
      ["ONBOARDING_GENERATION", "COMPLETED", 7],
    ]);
  });

  it("skips approval when policy review goes straight to provisioning", async () => {
    const wf = await createAt("ACCESS_PLANNING", "POLICY_REVIEW", "PROVISIONING");
    const audit = await service.listAuditEvents(wf.id);
    expect(audit.at(-1)).toMatchObject({
      fromState: "POLICY_REVIEW",
      toState: "PROVISIONING",
      payload: { approvalSkipped: true },
    });
    const steps = (await service.getWorkflow(wf.id))?.steps ?? [];
    expect(steps.some((s) => s.stepKey === "AWAITING_APPROVAL")).toBe(false);
  });

  it("alternates provisioning and approval, tracking attempts per phase", async () => {
    const wf = await createAt(
      "ACCESS_PLANNING",
      "POLICY_REVIEW",
      "PROVISIONING",
      "AWAITING_APPROVAL",
      "PROVISIONING",
    );
    const steps = (await service.getWorkflow(wf.id))?.steps ?? [];
    expect(
      steps.filter((s) => s.stepKey === "PROVISIONING").map((s) => [s.attempt, s.status]),
    ).toEqual([
      [1, "SUCCEEDED"],
      [2, "RUNNING"],
    ]);
  });

  it("records the failure reason and fails the open step", async () => {
    const wf = await createAt("ACCESS_PLANNING");
    const failed = await service.transition({
      workflowId: wf.id,
      to: "FAILED",
      expectedVersion: wf.version,
      actor: "test",
      reason: "planning crashed",
    });
    expect(failed).toMatchObject({ state: "FAILED", failureReason: "planning crashed" });
    const steps = (await service.getWorkflow(wf.id))?.steps ?? [];
    expect(steps.at(-1)).toMatchObject({
      stepKey: "ACCESS_PLANNING",
      status: "FAILED",
      error: "planning crashed",
    });
  });
});

describe("invalid transitions", () => {
  it("rejects a disallowed transition and leaves state, steps and audit untouched", async () => {
    const wf = await createAt();
    await expect(
      service.transition({ workflowId: wf.id, to: "COMPLETED", expectedVersion: 1, actor: "t" }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const details = await service.getWorkflow(wf.id);
    expect(details?.workflow).toMatchObject({ state: "RECEIVED", version: 1 });
    expect(details?.steps).toHaveLength(1);
    expect(await service.listAuditEvents(wf.id)).toHaveLength(1);
  });

  it("rejects any transition out of a terminal state", async () => {
    const wf = await createAt();
    const failed = await service.transition({
      workflowId: wf.id,
      to: "FAILED",
      expectedVersion: 1,
      actor: "t",
      reason: "cancelled",
    });
    await expect(
      service.transition({
        workflowId: wf.id,
        to: "ACCESS_PLANNING",
        expectedVersion: failed.version,
        actor: "t",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const done = await createAt(
      "ACCESS_PLANNING",
      "POLICY_REVIEW",
      "PROVISIONING",
      "ONBOARDING_GENERATION",
      "COMPLETED",
    );
    await expect(
      service.transition({
        workflowId: done.id,
        to: "FAILED",
        expectedVersion: done.version,
        actor: "t",
        reason: "late",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("rejects an unknown workflow", async () => {
    await expect(
      service.transition({
        workflowId: "00000000-0000-4000-8000-000000000000",
        to: "ACCESS_PLANNING",
        expectedVersion: 1,
        actor: "t",
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("rejects a stale expectedVersion", async () => {
    const wf = await createAt("ACCESS_PLANNING");
    await expect(
      service.transition({
        workflowId: wf.id,
        to: "POLICY_REVIEW",
        expectedVersion: 1,
        actor: "t",
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_VERSION_CONFLICT",
      expectedVersion: 1,
      actualVersion: 2,
    });
  });
});

describe("concurrent transitions", () => {
  it("lets exactly one of two competing decisions win; the other gets a version conflict", async () => {
    const wf = await createAt("ACCESS_PLANNING", "POLICY_REVIEW");
    // Separate pools stand in for two independent application instances.
    const other = createDatabase(inject("databaseUrl"));
    try {
      const otherService = createWorkflowService(other.db);
      const results = await Promise.allSettled([
        service.transition({
          workflowId: wf.id,
          to: "AWAITING_APPROVAL",
          expectedVersion: wf.version,
          actor: "a",
        }),
        otherService.transition({
          workflowId: wf.id,
          to: "PROVISIONING",
          expectedVersion: wf.version,
          actor: "b",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(WorkflowVersionConflictError);

      const winner = fulfilled[0]!.value;
      const details = await service.getWorkflow(wf.id);
      expect(details?.workflow).toMatchObject({ state: winner.state, version: wf.version + 1 });
      const transitions = (await service.listAuditEvents(wf.id)).filter(
        (e) => e.fromState === "POLICY_REVIEW",
      );
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.toState).toBe(winner.state);
      expect(details?.steps.filter((s) => s.status === "RUNNING")).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("serializes a burst of concurrent writers on the same version", async () => {
    const wf = await createAt();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service.transition({
          workflowId: wf.id,
          to: "ACCESS_PLANNING",
          expectedVersion: 1,
          actor: `w${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(WorkflowVersionConflictError);
    }
    expect(await service.listAuditEvents(wf.id)).toHaveLength(2);
    expect((await service.getWorkflow(wf.id))?.workflow.version).toBe(2);
  });
});

describe("transactional integrity", () => {
  it("rolls back the state change when the audit insert fails", async () => {
    const wf = await createAt();
    await handle.db.execute(sql`
      CREATE OR REPLACE FUNCTION test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.actor = 'audit-fails' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_reject_audit ON audit_events;
      CREATE TRIGGER test_reject_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION test_reject_audit();
    `);
    try {
      await expect(
        service.transition({
          workflowId: wf.id,
          to: "ACCESS_PLANNING",
          expectedVersion: 1,
          actor: "audit-fails",
        }),
      ).rejects.toThrow();

      const details = await service.getWorkflow(wf.id);
      expect(details?.workflow).toMatchObject({ state: "RECEIVED", version: 1 });
      expect(details?.steps).toMatchObject([{ stepKey: "RECEIVED", status: "RUNNING" }]);
      expect(await service.listAuditEvents(wf.id)).toHaveLength(1);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_reject_audit ON audit_events`);
    }
  });

  it("enforces append-only audit events in the database", async () => {
    const wf = await createAt();
    await expect(
      handle.db
        .update(auditEvents)
        .set({ actor: "tampered" })
        .where(eq(auditEvents.workflowId, wf.id)),
    ).rejects.toThrow();
    await expect(
      handle.db.delete(auditEvents).where(eq(auditEvents.workflowId, wf.id)),
    ).rejects.toThrow();
    await expect(handle.db.execute(sql`TRUNCATE audit_events CASCADE`)).rejects.toThrow();
    expect(await service.listAuditEvents(wf.id)).toHaveLength(1);
  });

  it("enforces the failure-reason invariant at the database level", async () => {
    const wf = await createAt();
    await expect(
      handle.db
        .update(onboardingWorkflows)
        .set({ state: "FAILED" })
        .where(eq(onboardingWorkflows.id, wf.id)),
    ).rejects.toThrow();
  });
});
