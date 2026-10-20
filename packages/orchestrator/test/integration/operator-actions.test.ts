import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import {
  accessRequests,
  approvals,
  auditEvents,
  createDatabase,
  externalOperations,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import { OUTBOX_EVENT_TYPES, type HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  OperatorActionError,
  SERVICENOW_CREATE_ACCESS_REQUEST,
  SERVICENOW_CREATE_FULFILLMENT_REQUEST,
  createAccessAuthorizationService,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createHrisIntakeService,
  createOperatorActionService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  noopLogger,
  type WorkflowService,
} from "../../src/index.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent, releasesBeforeM14 } from "./helpers.js";

/** M13: operator retry of a failed resource, and re-request of a lost approval ticket. */

let handle: DatabaseHandle;
let workflows: WorkflowService;
const { catalogs, policies } = releasesBeforeM14();
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
const CONTRACTOR = { ...ENGINEER, employmentType: "CONTRACTOR" } as const;
const DEV = "aws-dev";
const CURSOR = "cursor-license";
const OPERATOR = "m13.operator@example.com";

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  workflows = createWorkflowService(handle.db);
});
afterAll(() => handle.close());
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE status = 'PENDING'`);
});

function servicesFor(sn: FakeServiceNow) {
  const snOps = createExternalOperationService(handle.db, {
    servicenow: sn,
    handlers: [createServiceNowFulfillmentHandler(sn)],
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const fulfillment = createServiceNowFulfillmentService(handle.db, {
    catalogs,
    externalOperations: snOps,
    servicenow: sn,
    ownerId: "m13",
    leaseMs: 30_000,
    busyWaitMs: 5_000,
  });
  const coordinator = createProvisioningCoordinator(handle.db, {
    catalogs,
    workflows,
    servicenow: fulfillment,
    reconcileIntervalMs: 600_000,
    fulfillmentReconcileIntervalMs: 120_000,
    retryDelayMs: 600_000,
    sweepIntervalMs: 1,
  });
  const approvalService = createApprovalService(handle.db, { servicenow: sn, workflows });
  const actions = createOperatorActionService(handle.db, {
    externalOperations: snOps,
    servicenow: sn,
  });
  return { snOps, coordinator, approvalService, actions };
}

async function authorized(
  sn: FakeServiceNow,
  resourceIds: string[],
  facts: Partial<HrisOfferSignedEvent> = ENGINEER,
) {
  const event = newOfferSignedEvent({ ...ENGINEER, ...facts, jobDescription: "Synthetic." });
  const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  const wf = (await workflows.getWorkflow(workflowId))!.workflow;
  await workflows.transition({
    workflowId,
    to: "ACCESS_PLANNING",
    expectedVersion: wf.version,
    actor: "test",
  });
  const agent = createRoleAccessAgent({
    provider: createScriptedModelProvider([outputOf(...resourceIds)]),
    sleep: async () => {},
  });
  const { agentRunId } = await createRoleAccessRecommendationService(handle.db, {
    agent,
    catalogs,
  }).recommendAccess({ workflowId });
  const s = servicesFor(sn);
  const result = await createAccessAuthorizationService(handle.db, {
    policies,
    catalogs,
    workflows,
    externalOperations: s.snOps,
  }).authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((r) => [r.resourceId, r.accessRequestId]));
  const ops = Object.fromEntries(
    result.resources.map((r) => [r.resourceId, r.externalOperationId]),
  );
  return { workflowId, ids, ops, ...s };
}

async function drain(handlers: Parameters<typeof createEventHandlers>[0]) {
  const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
    workerId: "m13",
    batchSize: 10,
    leaseMs: 30_000,
    retry: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
    handlers: createEventHandlers(handlers),
    logger: noopLogger,
    random: () => 0,
  });
  for (let i = 0; i < 20; i++) if ((await runner.runOnce()).claimed === 0) return;
}

const rowFor = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;
const stateOf = async (workflowId: string) =>
  (await workflows.getWorkflow(workflowId))!.workflow.state;
const auditsOf = (workflowId: string, eventType: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, eventType)));
const opsOf = (workflowId: string, type: string) =>
  handle.db
    .select()
    .from(externalOperations)
    .where(
      and(
        eq(externalOperations.workflowId, workflowId),
        eq(externalOperations.operationType, type),
      ),
    )
    .orderBy(externalOperations.createdAt);
const approvalsOf = (workflowId: string) =>
  handle.db
    .select()
    .from(approvals)
    .where(eq(approvals.workflowId, workflowId))
    .orderBy(approvals.createdAt);
const makeDue = (id: string) =>
  handle.db
    .update(accessRequests)
    .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(accessRequests.id, id));

async function callback(
  a: { approvalService: ReturnType<typeof createApprovalService> },
  op: typeof externalOperations.$inferSelect,
  seq: number,
) {
  const { callbackEventId } = await a.approvalService.recordServiceNowCallback({
    eventId: `${op.externalId}:${seq}`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: op.externalId!,
    number: op.externalReference!,
    correlationKey: op.correlationKey,
  });
  return a.approvalService.processCallback(callbackEventId);
}

/** A failed ServiceNow fulfillment for aws-dev (the fulfiller marked it failed). */
async function failedFulfillment() {
  const sn = new FakeServiceNow();
  const a = await authorized(sn, [DEV]);
  await drain({ workflows, provisioning: a.coordinator });
  const first = sn.records.find((r) => r.requestKind === "fulfillment")!;
  sn.setFulfillmentState(first.sysId, "failed");
  await makeDue(a.ids[DEV]!);
  await a.coordinator.coordinateProvisioning({ workflowId: a.workflowId });
  expect(await rowFor(a.ids[DEV]!)).toMatchObject({ status: "PROVISIONING_FAILED" });
  return { sn, a, first };
}

describe("retry a failed resource", () => {
  it("opens a fresh fulfillment record, settles on read-back and completes provisioning", async () => {
    const { sn, a, first } = await failedFulfillment();
    const result = await a.actions.retryFailedResource({
      accessRequestId: a.ids[DEV]!,
      operatorId: OPERATOR,
    });
    expect(result).toMatchObject({ status: "READY_FOR_PROVISIONING", retryGeneration: 1 });
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      authorizedVia: "POLICY",
      retryGeneration: 1,
      provisioningErrorCode: null,
      provisioningOperationId: null,
      providerEvidence: null,
      orchestrationBlocker: null,
    });
    const [retryAudit] = await auditsOf(a.workflowId, "resource.retry_requested");
    expect(retryAudit).toMatchObject({ actor: `hr:${OPERATOR}` });
    expect(retryAudit!.payload).toMatchObject({
      retryGeneration: 1,
      previousErrorCode: "SERVICENOW_FULFILLMENT_FAILED",
    });

    // The wake written with the retry drives the coordinator: a second, distinct record.
    await drain({ workflows, provisioning: a.coordinator });
    const records = sn.records.filter((r) => r.requestKind === "fulfillment");
    expect(records).toHaveLength(2);
    const second = records[1]!;
    expect(second.correlationKey).not.toBe(first.correlationKey);
    const ops = await opsOf(a.workflowId, SERVICENOW_CREATE_FULFILLMENT_REQUEST);
    expect(ops).toHaveLength(2);
    expect(ops[1]!.idempotencyKey).toMatch(/:gen=1$/);
    expect(ops[0]!.idempotencyKey).not.toMatch(/:gen=/);

    sn.setFulfillmentState(second.sysId, "fulfilled");
    await makeDue(a.ids[DEV]!);
    await a.coordinator.coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONED",
      provisioningOperationId: ops[1]!.id,
      providerTargetId: second.sysId,
    });
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    // Both attempts stay in the audit record; the first failure is never rewritten.
    expect(await auditsOf(a.workflowId, "resource.provisioning_started")).toHaveLength(2);
    expect(await auditsOf(a.workflowId, "resource.provisioning_failed")).toHaveLength(1);
    expect(await auditsOf(a.workflowId, "resource.provisioned")).toHaveLength(1);
  });

  it("refuses anything that isn't a failed resource of an active plan, writing nothing", async () => {
    const sn = new FakeServiceNow();
    const a = await authorized(sn, [DEV]);
    const reject = (accessRequestId: string, operatorId = OPERATOR) =>
      a.actions.retryFailedResource({ accessRequestId, operatorId }).then(
        () => null,
        (err: unknown) => (err as OperatorActionError).code,
      );
    expect(await reject(a.ids[DEV]!)).toBe("NOT_FAILED");
    expect(await reject("00000000-0000-4000-8000-000000000000")).toBe("ACCESS_REQUEST_NOT_FOUND");
    expect(await reject(a.ids[DEV]!, "bad id with spaces")).toBe("OPERATOR_ID_REQUIRED");
    expect(await auditsOf(a.workflowId, "resource.retry_requested")).toHaveLength(0);
    expect((await rowFor(a.ids[DEV]!)).retryGeneration).toBe(0);
  });

  it("refuses a terminal workflow", async () => {
    const { a } = await failedFulfillment();
    const wf = (await workflows.getWorkflow(a.workflowId))!.workflow;
    await workflows.transition({
      workflowId: a.workflowId,
      to: "FAILED",
      expectedVersion: wf.version,
      actor: "test",
      reason: "test",
    });
    await expect(
      a.actions.retryFailedResource({ accessRequestId: a.ids[DEV]!, operatorId: OPERATOR }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_ACTIVE" });
  });

  it("6 concurrent retries: one succeeds, generation 1, one wake, one audit", async () => {
    const { a } = await failedFulfillment();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        a.actions.retryFailedResource({ accessRequestId: a.ids[DEV]!, operatorId: OPERATOR }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FAILED" });
    }
    expect((await rowFor(a.ids[DEV]!)).retryGeneration).toBe(1);
    expect(await auditsOf(a.workflowId, "resource.retry_requested")).toHaveLength(1);
    const wakes = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, a.workflowId),
          sql`${outboxEvents.payload}->>'reason' = 'RESOURCE_RETRY_REQUESTED'`,
        ),
      );
    expect(wakes).toHaveLength(1);
  });
});

/** cursor-license for a contractor: REQUIRES_APPROVAL, ticket created, approval PENDING. */
async function pendingApproval() {
  const sn = new FakeServiceNow();
  const a = await authorized(sn, [CURSOR], CONTRACTOR);
  await a.snOps.execute(a.ops[CURSOR]!, { ownerId: "t", leaseMs: 30_000 });
  expect(await stateOf(a.workflowId)).toBe("AWAITING_APPROVAL");
  const [approval] = await approvalsOf(a.workflowId);
  expect(approval).toMatchObject({ status: "PENDING" });
  return { sn, a, approval: approval! };
}

describe("request approval again", () => {
  it("refuses (changes nothing) while ServiceNow still has the ticket", async () => {
    const { sn, a, approval } = await pendingApproval();
    const accepted = await a.actions.requestApprovalAgain({
      accessRequestId: a.ids[CURSOR]!,
      operatorId: OPERATOR,
    });
    expect(accepted).toMatchObject({ status: "REQUESTED", approvalId: approval.id });
    await drain({ workflows, operatorActions: a.actions });
    expect(await auditsOf(a.workflowId, "access.approval_rerequest_refused")).toHaveLength(1);
    expect(await approvalsOf(a.workflowId)).toEqual([
      expect.objectContaining({ status: "PENDING" }),
    ]);
    expect(await rowFor(a.ids[CURSOR]!)).toMatchObject({
      externalOperationId: a.ops[CURSOR],
      retryGeneration: 0,
    });
    expect(sn.records).toHaveLength(1);
  });

  it("replaces a ticket ServiceNow no longer has; the new approval resumes the workflow", async () => {
    const { sn, a, approval } = await pendingApproval();
    const [oldOp] = await opsOf(a.workflowId, SERVICENOW_CREATE_ACCESS_REQUEST);
    const lost = sn.records.splice(0); // the instance was reclaimed: the ticket is gone

    await a.actions.requestApprovalAgain({ accessRequestId: a.ids[CURSOR]!, operatorId: OPERATOR });
    await drain({
      workflows,
      operatorActions: a.actions,
      externalOperations: { service: a.snOps, ownerId: "m13", leaseMs: 30_000 },
    });
    const ops = await opsOf(a.workflowId, SERVICENOW_CREATE_ACCESS_REQUEST);
    expect(ops).toHaveLength(2);
    const newOp = ops[1]!;
    expect(newOp).toMatchObject({ status: "SUCCEEDED" });
    expect(newOp.idempotencyKey).toBe(`${oldOp!.idempotencyKey}:gen=1`);
    expect(sn.records).toHaveLength(1);
    expect(sn.records[0]).toMatchObject({ approvalState: "pending", resourceId: CURSOR });
    const all = await approvalsOf(a.workflowId);
    expect(all.map((x) => x.status)).toEqual(["SUPERSEDED", "PENDING"]);
    expect(all[0]!.supersededAt).not.toBeNull();
    expect(await rowFor(a.ids[CURSOR]!)).toMatchObject({
      status: "AWAITING_APPROVAL",
      externalOperationId: newOp.id,
      retryGeneration: 1,
    });
    expect(await auditsOf(a.workflowId, "access.approval_rerequested")).toHaveLength(1);

    // Replays (the same event again, a second request) change nothing.
    const again = await a.actions.processApprovalRerequest({
      accessRequestId: a.ids[CURSOR]!,
      approvalId: approval.id,
      operatorId: OPERATOR,
    });
    expect(again.outcome).toBe("NOT_PENDING");
    expect(await opsOf(a.workflowId, SERVICENOW_CREATE_ACCESS_REQUEST)).toHaveLength(2);

    // A late callback for the old ticket never decides anything.
    sn.records.push({ ...lost[0]!, approvalState: "approved" });
    const stale = await callback(a, oldOp!, 9);
    expect(stale.outcome).toBe("SUPERSEDED");
    sn.records.pop(); // the old copy again
    expect((await rowFor(a.ids[CURSOR]!)).status).toBe("AWAITING_APPROVAL");
    expect(await stateOf(a.workflowId)).toBe("AWAITING_APPROVAL");

    // The approver approves the new ticket: the resource is authorized by that approval.
    sn.setApprovalState(newOp.externalId!, "approved");
    const decided = await callback(a, newOp, 1);
    expect(decided).toMatchObject({ outcome: "APPLIED_APPROVED", workflowResumed: true });
    expect(await rowFor(a.ids[CURSOR]!)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      authorizedVia: "APPROVAL",
      approvalId: all[1]!.id,
    });
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
    // Eligibility accepts the new chain: the MANUAL tool now waits on the operator.
    await a.coordinator.coordinateProvisioning({ workflowId: a.workflowId });
    expect((await rowFor(a.ids[CURSOR]!)).status).toBe("MANUAL_ACTION_REQUIRED");
  });

  it("refuses resources that aren't waiting on an approval ticket", async () => {
    const sn = new FakeServiceNow();
    const a = await authorized(sn, [DEV]);
    await expect(
      a.actions.requestApprovalAgain({ accessRequestId: a.ids[DEV]!, operatorId: OPERATOR }),
    ).rejects.toMatchObject({ code: "NOT_AWAITING_APPROVAL" });
    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, a.workflowId),
          eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.approvalRerequestRequested),
        ),
      );
    expect(outbox).toHaveLength(0);
  });

  it("a ServiceNow outage during the check retries later and changes nothing", async () => {
    const { sn, a, approval } = await pendingApproval();
    sn.records.splice(0);
    sn.failNextReads = 1;
    await expect(
      a.actions.processApprovalRerequest({
        accessRequestId: a.ids[CURSOR]!,
        approvalId: approval.id,
        operatorId: OPERATOR,
      }),
    ).rejects.toThrow(/503/);
    expect(await opsOf(a.workflowId, SERVICENOW_CREATE_ACCESS_REQUEST)).toHaveLength(1);
    expect((await approvalsOf(a.workflowId))[0]).toMatchObject({ status: "PENDING" });
  });
});
