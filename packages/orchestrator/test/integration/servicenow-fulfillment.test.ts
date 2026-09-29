import { randomUUID } from "node:crypto";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import {
  CATALOG_RELEASES,
  CatalogRegistry,
  ResourceCatalog,
  loadCatalogRegistry,
} from "@aoo/catalog";
import {
  accessRequests,
  auditEvents,
  createDatabase,
  externalOperations,
  outboxEvents,
  workflowProvisioningPlans,
  type DatabaseHandle,
} from "@aoo/db";
import type { GitHubTarget } from "@aoo/github";
import { loadPolicyRegistry } from "@aoo/policy";
import { OUTBOX_EVENT_TYPES, type HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  FulfillmentCallbackError,
  SERVICENOW_CREATE_FULFILLMENT_REQUEST,
  ServiceNowFulfillmentError,
  createAccessAuthorizationService,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubProvisioningService,
  createHrisIntakeService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentCallbackService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  noopLogger,
  type ProvisioningCoordinatorOptions,
  type WorkflowService,
} from "../../src/index.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const catalogs = loadCatalogRegistry();
const policies = loadPolicyRegistry(catalogs);
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
const CONTRACTOR = { ...ENGINEER, employmentType: "CONTRACTOR" } as const;
const DEV = "aws-dev";
const PROD = "aws-prod";
const ORG = "github-org-membership";
const TEAM = "github-team-backend";

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  workflows = createWorkflowService(handle.db);
});
afterAll(() => handle.close());
afterEach(async () => {
  vi.restoreAllMocks();
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE status = 'PENDING'`);
});

function world() {
  const sn = new FakeServiceNow();
  const gh = new FakeGitHub();
  gh.inviteActivates = true;
  const login = `m7d-${randomUUID().slice(0, 8)}`;
  gh.seedUser(login);
  gh.seedTeam("aoo-backend", "AOO Backend");
  return { sn, gh, login };
}
type World = ReturnType<typeof world>;

function fulfillmentFor(
  w: World,
  opts: { ownerId?: string; leaseMs?: number; catalogs?: CatalogRegistry } = {},
) {
  const extOps = createExternalOperationService(handle.db, {
    handlers: [createServiceNowFulfillmentHandler(w.sn), ...createGitHubHandlers(w.gh)],
    reconcile: { attempts: 2, delayMs: 1 },
  });
  const owner = {
    ownerId: opts.ownerId ?? `f-${Math.random().toString(36).slice(2, 8)}`,
    leaseMs: opts.leaseMs ?? 30_000,
    busyWaitMs: 5_000,
  };
  const service = createServiceNowFulfillmentService(handle.db, {
    catalogs: opts.catalogs ?? catalogs,
    externalOperations: extOps,
    servicenow: w.sn,
    ...owner,
  });
  const ghTargets = new Map<string, GitHubTarget>([
    [ORG, { kind: "org", resourceId: ORG, org: w.gh.org }],
    [
      TEAM,
      {
        kind: "team",
        resourceId: TEAM,
        org: w.gh.org,
        teamSlug: "aoo-backend",
        teamName: "AOO Backend",
      },
    ],
  ]);
  const github = createGitHubProvisioningService(handle.db, {
    catalogs,
    externalOperations: extOps,
    github: w.gh,
    targets: ghTargets,
    ...owner,
  });
  return { service, extOps, github };
}

function coordinatorFor(w: World, opts: Partial<ProvisioningCoordinatorOptions> = {}) {
  const f = fulfillmentFor(w);
  return createProvisioningCoordinator(handle.db, {
    catalogs,
    workflows,
    servicenow: f.service,
    github: f.github,
    reconcileIntervalMs: 600_000,
    fulfillmentReconcileIntervalMs: 120_000,
    retryDelayMs: 600_000,
    // Several sweeps per test: a 1 ms bucket (M7C covers per-bucket de-duplication itself).
    sweepIntervalMs: 1,
    ...opts,
  });
}

async function authorized(
  w: World,
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
  const snOps = createExternalOperationService(handle.db, {
    servicenow: w.sn,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const approvals = createApprovalService(handle.db, { servicenow: w.sn, workflows });
  const result = await createAccessAuthorizationService(handle.db, {
    policies,
    catalogs,
    workflows,
    externalOperations: snOps,
  }).authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((r) => [r.resourceId, r.accessRequestId]));
  const ops = Object.fromEntries(
    result.resources.map((r) => [r.resourceId, r.externalOperationId]),
  );
  return { workflowId, agentRunId, ids, ops, snOps, approvals };
}

/** M4C: creates the APPROVAL ticket and applies a verified decision (as the worker would). */
async function decide(
  a: Awaited<ReturnType<typeof authorized>>,
  w: World,
  resourceId: string,
  state: "approved" | "rejected",
) {
  const opId = a.ops[resourceId]!;
  const done = await a.snOps.execute(opId, { ownerId: "t", leaseMs: 30_000 });
  w.sn.setApprovalState(done.externalId, state);
  const [op] = await handle.db
    .select()
    .from(externalOperations)
    .where(eq(externalOperations.id, opId));
  const { callbackEventId } = await a.approvals.recordServiceNowCallback({
    eventId: `${op!.externalId}:1`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: op!.externalId!,
    number: op!.externalReference!,
    correlationKey: op!.correlationKey,
  });
  return a.approvals.processCallback(callbackEventId);
}

async function drainWakes(coordinator: ReturnType<typeof coordinatorFor>) {
  const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
    workerId: "w1",
    batchSize: 10,
    leaseMs: 30_000,
    retry: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
    handlers: createEventHandlers({ workflows, provisioning: coordinator }),
    logger: noopLogger,
    random: () => 0,
  });
  for (let i = 0; i < 20; i++) if ((await runner.runOnce()).claimed === 0) return;
}

const fulfillmentRecords = (w: World) =>
  w.sn.records.filter((r) => r.requestKind === "fulfillment");
const recordFor = (w: World, resourceId: string) =>
  fulfillmentRecords(w).find((r) => r.resourceId === resourceId);
const rowFor = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;
const stateOf = async (workflowId: string) =>
  (await workflows.getWorkflow(workflowId))!.workflow.state;
const opsOf = (workflowId: string) =>
  handle.db
    .select()
    .from(externalOperations)
    .where(
      and(
        eq(externalOperations.workflowId, workflowId),
        eq(externalOperations.operationType, SERVICENOW_CREATE_FULFILLMENT_REQUEST),
      ),
    );
const auditsOf = (workflowId: string, eventType: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, eventType)));
const transitionsToOnboarding = (workflowId: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workflowId, workflowId),
        eq(auditEvents.eventType, "workflow.transitioned"),
        eq(auditEvents.toState, "ONBOARDING_GENERATION"),
      ),
    );
const makeDue = (id: string) =>
  handle.db
    .update(accessRequests)
    .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(accessRequests.id, id));
const callbackFor = (w: World, resourceId: string, seq: string, claimed?: string) => {
  const r = recordFor(w, resourceId)!;
  return {
    eventId: `${r.sysId}:${seq}`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: r.sysId,
    number: r.number,
    correlationKey: r.correlationKey,
    ...(claimed && { claimedFulfillmentState: claimed }),
  };
};

describe("fulfillment for an ALLOW resource", () => {
  it("creates exactly one dedicated fulfillment record; the resource stays PROVISIONING until fulfilled", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    expect(fulfillmentRecords(w)).toHaveLength(1);
    const record = recordFor(w, DEV)!;
    expect(record).toMatchObject({
      requestKind: "fulfillment",
      fulfillmentState: "pending",
      approvalState: "not_required",
      policyDecision: "allow",
      workflowId: a.workflowId,
      resourceId: DEV,
    });
    expect(record.correlationKey).toMatch(/^aoo-ful-/);
    const row = await rowFor(a.ids[DEV]!);
    expect(row).toMatchObject({
      status: "PROVISIONING",
      providerState: "FULFILLMENT_PENDING",
      orchestrationBlocker: "SERVICENOW_FULFILLMENT_PENDING",
      blockerClass: "WAITING",
      providerEvidence: {
        serviceNowSysId: record.sysId,
        ticketNumber: record.number,
        fulfillmentState: "pending",
      },
    });
    const delay = row.nextReconcileAt!.getTime() - Date.now();
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThanOrEqual(120_000);
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
    expect(await auditsOf(a.workflowId, "servicenow.fulfillment_requested")).toHaveLength(1);
    expect(await auditsOf(a.workflowId, "servicenow.fulfillment_pending")).toHaveLength(1);
    // Replay while pending: no second POST, no second operation.
    await makeDue(a.ids[DEV]!);
    await c.coordinateProvisioning({ workflowId: a.workflowId });
    expect(w.sn.posts).toBe(1);
    expect(await opsOf(a.workflowId)).toHaveLength(1);
  });

  it("periodic reconciliation (no callback): in_progress, then fulfilled → PROVISIONED → ONBOARDING_GENERATION", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    const record = recordFor(w, DEV)!;
    w.sn.setFulfillmentState(record.sysId, "in_progress");
    const reads = w.sn.reads;
    await c.coordinateProvisioning({ workflowId: a.workflowId }); // not due yet: no read
    expect(w.sn.reads).toBe(reads);
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 0 });
    await makeDue(a.ids[DEV]!);
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 1 });
    await drainWakes(c);
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONING",
      providerState: "FULFILLMENT_IN_PROGRESS",
      orchestrationBlocker: "SERVICENOW_FULFILLMENT_IN_PROGRESS",
    });
    w.sn.setFulfillmentState(record.sysId, "fulfilled");
    await makeDue(a.ids[DEV]!);
    await c.enqueueDueWakes();
    await drainWakes(c);
    const [op] = await opsOf(a.workflowId);
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONED",
      provisioningOperationId: op!.id,
      providerTargetId: record.sysId,
      orchestrationBlocker: null,
      providerEvidence: {
        serviceNowSysId: record.sysId,
        ticketNumber: record.number,
        fulfillmentState: "fulfilled",
        requestKind: "fulfillment",
        operationId: op!.id,
      },
    });
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(
      (
        await handle.db
          .select()
          .from(workflowProvisioningPlans)
          .where(eq(workflowProvisioningPlans.workflowId, a.workflowId))
      )[0],
    ).toMatchObject({ status: "COMPLETE" });
    expect(await auditsOf(a.workflowId, "servicenow.fulfillment_verified")).toHaveLength(1);
    expect(await auditsOf(a.workflowId, "resource.provisioned")).toHaveLength(1);
    expect(w.sn.posts).toBe(1);
    // Replay after PROVISIONED: no ServiceNow call at all.
    const calls = w.sn.reads + w.sn.queries + w.sn.posts;
    const replay = await fulfillmentFor(w).service.provisionServiceNowAccess({
      accessRequestId: a.ids[DEV]!,
    });
    expect(replay).toMatchObject({ status: "PROVISIONED", replayed: true, sysId: record.sysId });
    expect(w.sn.reads + w.sn.queries + w.sn.posts).toBe(calls);
    expect(await transitionsToOnboarding(a.workflowId)).toHaveLength(1);
  });

  it("a fulfiller-reported failure → PROVISIONING_FAILED (not DENIED/REJECTED); unrelated resources continue", async () => {
    const w = world();
    const a = await authorized(w, [DEV, ORG]);
    await createGitHubClaim(a.workflowId, w.login);
    const c = coordinatorFor(w);
    await drainWakes(c);
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "failed");
    await makeDue(a.ids[DEV]!);
    await c.coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONING_FAILED",
      provisioningErrorCode: "SERVICENOW_FULFILLMENT_FAILED",
      orchestrationBlocker: "PROVISIONING_FAILED",
    });
    expect((await rowFor(a.ids[ORG]!)).status).toBe("PROVISIONED");
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
    expect(await auditsOf(a.workflowId, "servicenow.fulfillment_failed")).toHaveLength(1);
  });
});

async function createGitHubClaim(workflowId: string, githubLogin: string) {
  const { createGitHubIdentityService } = await import("../../src/index.js");
  await createGitHubIdentityService(handle.db, { catalogs }).submitClaim({
    workflowId,
    githubLogin,
    operatorId: "hr.test",
  });
}

describe("approval and fulfillment stay distinct; dependencies are respected", () => {
  it("aws-dev (ALLOW) then aws-prod (approved, depends on aws-dev): two separate fulfillment records, in order", async () => {
    const w = world();
    const a = await authorized(w, [DEV, PROD]);
    expect(await stateOf(a.workflowId)).toBe("AWAITING_APPROVAL");
    const c = coordinatorFor(w);
    await drainWakes(c);
    expect(fulfillmentRecords(w).map((r) => r.resourceId)).toEqual([DEV]);
    expect((await rowFor(a.ids[PROD]!)).orchestrationBlocker).toBe("AWAITING_APPROVAL");

    // Approved while aws-dev is still being fulfilled: no aws-prod fulfillment yet.
    await decide(a, w, PROD, "approved");
    await drainWakes(c);
    expect(await rowFor(a.ids[PROD]!)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      orchestrationBlocker: "DEPENDENCIES_NOT_READY",
    });
    expect(fulfillmentRecords(w).map((r) => r.resourceId)).toEqual([DEV]);

    // aws-dev fulfilled → PROVISIONED → dependency satisfied → aws-prod fulfillment in the same pass.
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
    await makeDue(a.ids[DEV]!);
    await c.enqueueDueWakes();
    await drainWakes(c);
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
    expect(fulfillmentRecords(w).map((r) => r.resourceId)).toEqual([DEV, PROD]);
    const approvalTicket = w.sn.records.find(
      (r) => r.resourceId === PROD && r.requestKind !== "fulfillment",
    )!;
    const prodFulfillment = recordFor(w, PROD)!;
    expect(prodFulfillment.sysId).not.toBe(approvalTicket.sysId);
    expect(prodFulfillment.correlationKey).not.toBe(approvalTicket.correlationKey);
    expect(prodFulfillment).toMatchObject({
      policyDecision: "requires_approval",
      approvalState: "not_required",
    });
    expect(approvalTicket.approvalState).toBe("approved"); // the approval record is untouched

    w.sn.setFulfillmentState(prodFulfillment.sysId, "fulfilled");
    await makeDue(a.ids[PROD]!);
    await c.enqueueDueWakes();
    await drainWakes(c);
    expect((await rowFor(a.ids[PROD]!)).status).toBe("PROVISIONED");
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(await transitionsToOnboarding(a.workflowId)).toHaveLength(1);
  });

  it("denied and rejected resources never get a fulfillment record", async () => {
    const w = world();
    const denied = await authorized(w, [PROD], CONTRACTOR); // contractor: aws-prod DENY
    const rejected = await authorized(w, [PROD]); // full-time: REQUIRES_APPROVAL
    await decide(rejected, w, PROD, "rejected");
    await drainWakes(coordinatorFor(w));
    expect(fulfillmentRecords(w)).toHaveLength(0);
    expect((await rowFor(denied.ids[PROD]!)).status).toBe("DENIED");
    expect((await rowFor(rejected.ids[PROD]!)).status).toBe("REJECTED");
    expect(await stateOf(denied.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(await stateOf(rejected.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("zero fulfillment writes across the authorization boundary (direct service calls)", async () => {
    const w = world();
    const svc = fulfillmentFor(w).service;
    const code = async (id: string, s = svc) => {
      try {
        await s.provisionServiceNowAccess({ accessRequestId: id });
      } catch (err) {
        if (err instanceof ServiceNowFulfillmentError) return err.code;
        throw err;
      }
      return "OK";
    };
    const denied = await authorized(w, [PROD], CONTRACTOR);
    const awaiting = await authorized(w, [PROD]);
    const rejected = await authorized(w, [PROD]);
    await decide(rejected, w, PROD, "rejected");
    const okta = await authorized(w, ["okta-engineering-group"]);
    const forged = await authorized(w, [PROD], CONTRACTOR);
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'POLICY' WHERE id = ${forged.ids[PROD]}`,
    );
    const unverified = await authorized(w, [PROD]);
    const opRow = await rowFor(unverified.ids[PROD]!);
    await unverified.snOps.execute(opRow.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'APPROVAL', approval_id = (SELECT id FROM approvals WHERE external_operation_id = ${opRow.externalOperationId}) WHERE id = ${opRow.id}`,
    );
    const depMissing = await authorized(w, [DEV, PROD]);
    await decide(depMissing, w, PROD, "approved"); // aws-prod READY but aws-dev not PROVISIONED
    const clean = await authorized(w, [DEV]);
    const base = CATALOG_RELEASES[0]!;
    const altered = structuredClone(base.document) as {
      resources: { resourceId: string; description: string }[];
    };
    altered.resources.find((r) => r.resourceId === DEV)!.description = "Altered.";
    const wrongCatalog = fulfillmentFor(w, {
      catalogs: new CatalogRegistry({
        releases: [{ document: altered, catalogHash: new ResourceCatalog(altered).catalogHash }],
        currentVersion: "1.0.0",
      }),
    }).service;
    const historical = await authorized(w, [DEV]);
    const clonedId = await cloneRequestIntoHistoricalRun(historical.agentRunId, DEV);

    const before = w.sn.posts;
    expect(await code(denied.ids[PROD]!)).toBe("NOT_ELIGIBLE");
    expect(await code(rejected.ids[PROD]!)).toBe("NOT_ELIGIBLE");
    expect(await code(awaiting.ids[PROD]!)).toBe("NOT_ELIGIBLE");
    expect(await code(okta.ids["okta-engineering-group"]!)).toBe("PROVIDER_MISMATCH");
    expect(await code(forged.ids[PROD]!)).toBe("AUTHORIZATION_CHAIN_INVALID");
    expect(await code(opRow.id)).toBe("AUTHORIZATION_CHAIN_INVALID");
    expect(await code(depMissing.ids[PROD]!)).toBe("DEPENDENCIES_NOT_READY");
    expect(await code(clean.ids[DEV]!, wrongCatalog)).toBe("CATALOG_UNAVAILABLE");
    expect(await code(clonedId)).toBe("NOT_IN_ACTIVE_PLAN");
    expect(await code(randomUUID())).toBe("ACCESS_REQUEST_NOT_FOUND");
    expect(w.sn.posts).toBe(before);
    expect(fulfillmentRecords(w)).toHaveLength(0);
  });
});

/** Copies one request (with its decision and run) into a new, non-plan "historical" agent run. */
async function cloneRequestIntoHistoricalRun(
  agentRunId: string,
  resourceId: string,
): Promise<string> {
  const newRun = randomUUID();
  const newDecision = randomUUID();
  const newRequest = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO agent_runs SELECT (jsonb_populate_record(NULL::agent_runs, to_jsonb(r)
      || jsonb_build_object('id', ${newRun}::uuid, 'logical_run_key', r.logical_run_key || ':clone'))).*
    FROM agent_runs r WHERE r.id = ${agentRunId}`);
  await handle.db.execute(sql`
    INSERT INTO access_decisions SELECT (jsonb_populate_record(NULL::access_decisions, to_jsonb(d)
      || jsonb_build_object('id', ${newDecision}::uuid, 'agent_run_id', ${newRun}::uuid,
           'logical_decision_key', d.logical_decision_key || ':clone'))).*
    FROM access_decisions d WHERE d.agent_run_id = ${agentRunId} AND d.resource_id = ${resourceId}`);
  await handle.db.execute(sql`
    INSERT INTO access_requests SELECT (jsonb_populate_record(NULL::access_requests, to_jsonb(q)
      || jsonb_build_object('id', ${newRequest}::uuid, 'agent_run_id', ${newRun}::uuid,
           'access_decision_id', ${newDecision}::uuid, 'status', 'READY_FOR_PROVISIONING'))).*
    FROM access_requests q WHERE q.agent_run_id = ${agentRunId} AND q.resource_id = ${resourceId}`);
  return newRequest;
}

describe("durability: lost responses, concurrency, stale owners", () => {
  it("a lost create response is reconciled by correlation key: one record, no second POST", async () => {
    const w = world();
    w.sn.createBehaviors.push("lost-after-create");
    w.sn.hideFromNextQueries = 5; // the record isn't visible yet: the operation stays OUTCOME_UNKNOWN
    const a = await authorized(w, [DEV]);
    const svc = fulfillmentFor(w).service;
    await expect(
      svc.provisionServiceNowAccess({ accessRequestId: a.ids[DEV]! }),
    ).rejects.toMatchObject({ code: "RETRY_LATER" });
    expect((await opsOf(a.workflowId))[0]!.status).toBe("OUTCOME_UNKNOWN");
    w.sn.hideFromNextQueries = 0;
    const done = await fulfillmentFor(w).service.provisionServiceNowAccess({
      accessRequestId: a.ids[DEV]!,
    });
    expect(done.status).toBe("FULFILLMENT_PENDING");
    expect(w.sn.posts).toBe(1);
    expect(fulfillmentRecords(w)).toHaveLength(1);
    expect((await opsOf(a.workflowId))[0]!.status).toBe("SUCCEEDED");
  });

  it("duplicate records for one correlation key stop automation (never pick one)", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    const original = recordFor(w, DEV)!;
    w.sn.insert({
      shortDescription: original.shortDescription,
      employeeId: original.employeeId,
      workflowId: original.workflowId,
      resourceId: original.resourceId,
      requestedEntitlement: original.requestedEntitlement,
      policyDecision: "allow",
      requestKind: "fulfillment",
      fulfillmentState: "pending",
      correlationKey: original.correlationKey,
    });
    await handle.db
      .update(externalOperations)
      .set({ status: "PENDING", externalId: null, externalReference: null, completedAt: null })
      .where(eq(externalOperations.workflowId, a.workflowId));
    await makeDue(a.ids[DEV]!);
    await c.coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONING_FAILED",
      provisioningErrorCode: "DUPLICATE_FULFILLMENT_RECORDS",
    });
    expect((await opsOf(a.workflowId))[0]!.status).toBe("CONFLICT");
  });

  it.each([2, 6])(
    "%i concurrent dispatches: one record, one operation, one PROVISIONED transition",
    async (n) => {
      const w = world();
      const a = await authorized(w, [DEV]);
      const results = await Promise.allSettled(
        Array.from({ length: n }, () =>
          fulfillmentFor(w).service.provisionServiceNowAccess({ accessRequestId: a.ids[DEV]! }),
        ),
      );
      for (const r of results) {
        if (r.status === "rejected")
          expect((r.reason as ServiceNowFulfillmentError).code).toBe("RETRY_LATER");
      }
      expect(w.sn.posts).toBe(1);
      expect(fulfillmentRecords(w)).toHaveLength(1);
      expect(await opsOf(a.workflowId)).toHaveLength(1);
      w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
      await Promise.allSettled(
        Array.from({ length: n }, () =>
          fulfillmentFor(w).service.provisionServiceNowAccess({ accessRequestId: a.ids[DEV]! }),
        ),
      );
      expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
      expect(await auditsOf(a.workflowId, "resource.provisioned")).toHaveLength(1);
      expect(w.sn.posts).toBe(1);
    },
  );

  it("a stale owner finishing late creates nothing and overwrites nothing", async () => {
    const w = world();
    let release!: () => void;
    w.sn.createBehaviors.push({ hold: new Promise<void>((r) => (release = r)) });
    const a = await authorized(w, [DEV]);
    const stale = fulfillmentFor(w, { ownerId: "stale" })
      .service.provisionServiceNowAccess({ accessRequestId: a.ids[DEV]! })
      .then(
        () => "done",
        (e: ServiceNowFulfillmentError) => e.code,
      );
    for (let i = 0; i < 100 && w.sn.posts === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await handle.db.execute(
      sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE workflow_id = ${a.workflowId}`,
    );
    const fresh = await fulfillmentFor(w, { ownerId: "fresh" }).service.provisionServiceNowAccess({
      accessRequestId: a.ids[DEV]!,
    });
    expect(fresh.status).toBe("FULFILLMENT_PENDING");
    release();
    await stale;
    expect(fulfillmentRecords(w)).toHaveLength(1); // the provider's unique key refused the late insert
    const [op] = await opsOf(a.workflowId);
    expect(op).toMatchObject({ status: "SUCCEEDED", externalId: fresh.sysId });
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONING");
  });
});

describe("fulfillment callbacks: notifications only", () => {
  it("6 duplicate callbacks → one recorded event, one wake, one authoritative transition", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
    const callbacks = createServiceNowFulfillmentCallbackService(handle.db);
    const cb = callbackFor(w, DEV, "2", "fulfilled");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => callbacks.recordFulfillmentCallback(cb)),
    );
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.duplicate)).toHaveLength(1);
    expect(await auditsOf(a.workflowId, "servicenow.fulfillment_callback_received")).toHaveLength(
      1,
    );
    const wakes = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, a.workflowId),
          eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.provisioningWorkflowWake),
          sql`${outboxEvents.payload}->>'reason' = 'SERVICENOW_FULFILLMENT_CHANGED'`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const reads = w.sn.reads;
    await drainWakes(c); // the callback made the request due: the worker reads ServiceNow now
    expect(w.sn.reads).toBe(reads + 1);
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
    expect(await auditsOf(a.workflowId, "resource.provisioned")).toHaveLength(1);
    expect(await transitionsToOnboarding(a.workflowId)).toHaveLength(1);
    await expect(
      callbacks.recordFulfillmentCallback({ ...cb, number: "OAR9999999" }),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(
      callbacks.recordFulfillmentCallback({ ...cb, correlationKey: "aoo-ful-unknown-key-000000" }),
    ).rejects.toBeInstanceOf(FulfillmentCallbackError);
  });

  it("the callback's claim is never trusted: a 'fulfilled' claim while ServiceNow says pending changes nothing", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    await createServiceNowFulfillmentCallbackService(handle.db).recordFulfillmentCallback(
      callbackFor(w, DEV, "2", "fulfilled"),
    );
    await drainWakes(c);
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONING",
      providerState: "FULFILLMENT_PENDING",
    });
  });

  it("stale, out-of-order notifications never move local state backward", async () => {
    const w = world();
    const a = await authorized(w, [DEV]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    const callbacks = createServiceNowFulfillmentCallbackService(handle.db);
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
    // An older "pending" notification arrives after ServiceNow is already fulfilled.
    await callbacks.recordFulfillmentCallback(callbackFor(w, DEV, "1", "pending"));
    await drainWakes(c);
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED"); // read-back decided
    // A later ServiceNow change (fulfilled → pending) and its callback don't undo PROVISIONED.
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "pending");
    await callbacks.recordFulfillmentCallback(callbackFor(w, DEV, "3", "pending"));
    await drainWakes(c);
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
    expect(await transitionsToOnboarding(a.workflowId)).toHaveLength(1);
  });
});

describe("independence and isolation", () => {
  it("a waiting GitHub resource doesn't block ServiceNow fulfillment (and vice versa for completion)", async () => {
    const w = world();
    const a = await authorized(w, [ORG, TEAM, DEV]); // no HR GitHub claim: GitHub waits
    const c = coordinatorFor(w);
    await drainWakes(c);
    expect(await rowFor(a.ids[ORG]!)).toMatchObject({
      orchestrationBlocker: "GITHUB_IDENTITY_CLAIM_REQUIRED",
    });
    expect(await rowFor(a.ids[DEV]!)).toMatchObject({
      status: "PROVISIONING",
      providerState: "FULFILLMENT_PENDING",
    });
    expect(fulfillmentRecords(w)).toHaveLength(1);
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
    await makeDue(a.ids[DEV]!);
    await c.enqueueDueWakes();
    await drainWakes(c);
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING"); // GitHub still unresolved
  });

  it("makes no network or model call (fakes only)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = world();
    const a = await authorized(w, [DEV]);
    await drainWakes(coordinatorFor(w));
    w.sn.setFulfillmentState(recordFor(w, DEV)!.sysId, "fulfilled");
    await createServiceNowFulfillmentCallbackService(handle.db).recordFulfillmentCallback(
      callbackFor(w, DEV, "2"),
    );
    await drainWakes(coordinatorFor(w));
    expect((await rowFor(a.ids[DEV]!)).status).toBe("PROVISIONED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
