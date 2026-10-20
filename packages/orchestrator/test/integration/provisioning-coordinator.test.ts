import { randomUUID } from "node:crypto";
import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
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
import type { OktaGroupTarget } from "@aoo/okta";
import { OUTBOX_EVENT_TYPES, type HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  ManualCompletionError,
  ProvisioningPlanError,
  createAccessAuthorizationService,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubIdentityService,
  createGitHubProvisioningService,
  createHrisIntakeService,
  createManualProvisioningService,
  createOktaHandlers,
  createOktaProvisioningService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createProvisioningPlan,
  createRoleAccessRecommendationService,
  createWorkflowService,
  noopLogger,
  type ProvisioningCoordinatorOptions,
  type WorkflowService,
} from "../../src/index.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeOkta } from "./fake-okta.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent, releasesBeforeM14 } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const { catalogs, policies } = releasesBeforeM14();
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
const CONTRACTOR = { ...ENGINEER, employmentType: "CONTRACTOR" } as const;
const OKTA = "okta-engineering-group";
const ORG = "github-org-membership";
const TEAM = "github-team-backend";
const MANUAL = "cursor-license";
const OPERATOR = "hr.test";

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

/** Fake Okta/GitHub/ServiceNow worlds, one per test. */
let seq = 0;
function world(opts: { inviteActivates?: boolean } = {}) {
  const okta = new FakeOkta();
  const engGroup = okta.seedGroup("AOO Engineering (test)");
  const gh = new FakeGitHub();
  gh.inviteActivates = opts.inviteActivates ?? true;
  const login = `m7c-${Date.now().toString(36)}-${seq++}`;
  const user = gh.seedUser(login);
  gh.seedTeam("aoo-backend", "AOO Backend");
  const sn = new FakeServiceNow();
  return { okta, engGroup, gh, login, user, sn };
}
type World = ReturnType<typeof world>;

function coordinatorFor(w: World, opts: Partial<ProvisioningCoordinatorOptions> = {}) {
  const extOps = createExternalOperationService(handle.db, {
    handlers: [...createOktaHandlers(w.okta), ...createGitHubHandlers(w.gh)],
    reconcile: { attempts: 2, delayMs: 1 },
  });
  const owner = {
    ownerId: `c-${Math.random().toString(36).slice(2, 8)}`,
    leaseMs: 30_000,
    busyWaitMs: 5_000,
  };
  const oktaTargets = new Map<string, OktaGroupTarget>([
    [OKTA, { resourceId: OKTA, groupId: w.engGroup, expectedName: "AOO Engineering (test)" }],
  ]);
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
  return createProvisioningCoordinator(handle.db, {
    catalogs,
    workflows,
    okta: createOktaProvisioningService(handle.db, {
      catalogs,
      externalOperations: extOps,
      okta: w.okta,
      targets: oktaTargets,
      ...owner,
    }),
    github: createGitHubProvisioningService(handle.db, {
      catalogs,
      externalOperations: extOps,
      github: w.gh,
      targets: ghTargets,
      ...owner,
    }),
    reconcileIntervalMs: 600_000,
    retryDelayMs: 600_000,
    ...opts,
  });
}

function snServices(w: World) {
  const extOps = createExternalOperationService(handle.db, {
    servicenow: w.sn,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  return {
    extOps,
    authz: createAccessAuthorizationService(handle.db, {
      policies,
      catalogs,
      workflows,
      externalOperations: extOps,
    }),
    approvals: createApprovalService(handle.db, { servicenow: w.sn, workflows }),
  };
}

/** HRIS → ACCESS_PLANNING → scripted M6A run → M6B authorization (+ HR GitHub claim if given). */
async function authorized(
  w: World,
  resourceIds: string[],
  facts: Partial<HrisOfferSignedEvent> = ENGINEER,
  githubLogin?: string,
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
  const s = snServices(w);
  const result = await s.authz.authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((r) => [r.resourceId, r.accessRequestId]));
  const ops = Object.fromEntries(
    result.resources.map((r) => [r.resourceId, r.externalOperationId]),
  );
  if (githubLogin) await claim(workflowId, githubLogin);
  return { workflowId, agentRunId, ids, ops, s };
}

const claim = (workflowId: string, githubLogin: string) =>
  createGitHubIdentityService(handle.db, { catalogs }).submitClaim({
    workflowId,
    githubLogin,
    operatorId: OPERATOR,
  });

/** Creates the ticket, then applies a verified approval decision through M4C (as the worker would). */
async function decide(
  a: Awaited<ReturnType<typeof authorized>>,
  w: World,
  resourceId: string,
  state: "approved" | "rejected",
) {
  const opId = a.ops[resourceId]!;
  const done = await a.s.extOps.execute(opId, { ownerId: "t", leaseMs: 30_000 });
  w.sn.setApprovalState(done.externalId, state);
  const [op] = await handle.db
    .select()
    .from(externalOperations)
    .where(eq(externalOperations.id, opId));
  const { callbackEventId } = await a.s.approvals.recordServiceNowCallback({
    eventId: `${op!.externalId}:1`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: op!.externalId!,
    number: op!.externalReference!,
    correlationKey: op!.correlationKey,
  });
  return a.s.approvals.processCallback(callbackEventId);
}

/** Runs the real outbox runner with the provisioning wake handler until no event is left. */
async function drainWakes(coordinator: ReturnType<typeof coordinatorFor>, workerId = "w1") {
  const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
    workerId,
    batchSize: 10,
    leaseMs: 30_000,
    retry: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
    handlers: createEventHandlers({ workflows, provisioning: coordinator }),
    logger: noopLogger,
    random: () => 0,
  });
  let processed = 0;
  for (let i = 0; i < 20; i++) {
    const summary = await runner.runOnce();
    if (summary.claimed === 0) break;
    processed += summary.succeeded;
  }
  return processed;
}

const rowsOf = (agentRunId: string) =>
  handle.db.select().from(accessRequests).where(eq(accessRequests.agentRunId, agentRunId));
const rowFor = async (agentRunId: string, resourceId: string) =>
  (await rowsOf(agentRunId)).find((r) => r.resourceId === resourceId)!;
const stateOf = async (workflowId: string) =>
  (await workflows.getWorkflow(workflowId))!.workflow.state;
const plansOf = (workflowId: string) =>
  handle.db
    .select()
    .from(workflowProvisioningPlans)
    .where(eq(workflowProvisioningPlans.workflowId, workflowId));
const opsOf = (workflowId: string, type: string) =>
  handle.db
    .select()
    .from(externalOperations)
    .where(
      and(
        eq(externalOperations.workflowId, workflowId),
        eq(externalOperations.operationType, type),
      ),
    );
const auditsOf = (workflowId: string, eventType: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, eventType)));
const completionTransitions = (workflowId: string) =>
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
const wakesOf = (workflowId: string, reason?: string) =>
  handle.db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, workflowId),
        eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.provisioningWorkflowWake),
        ...(reason ? [sql`${outboxEvents.payload}->>'reason' = ${reason}`] : []),
      ),
    );
const ghCalls = (w: World) => w.gh.reads + w.gh.writes;

/** Clones an agent run with its decisions and requests (a "historical" run of the same workflow). */
async function cloneRun(agentRunId: string): Promise<string> {
  const newRun = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO agent_runs SELECT (jsonb_populate_record(NULL::agent_runs, to_jsonb(r)
      || jsonb_build_object('id', ${newRun}::uuid, 'logical_run_key', r.logical_run_key || ':clone'))).*
    FROM agent_runs r WHERE r.id = ${agentRunId}`);
  const decisions = await handle.db.execute<{ id: string }>(
    sql`SELECT id FROM access_decisions WHERE agent_run_id = ${agentRunId}`,
  );
  for (const d of decisions.rows) {
    const newDecision = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO access_decisions SELECT (jsonb_populate_record(NULL::access_decisions, to_jsonb(d)
        || jsonb_build_object('id', ${newDecision}::uuid, 'agent_run_id', ${newRun}::uuid,
             'logical_decision_key', d.logical_decision_key || ':clone'))).*
      FROM access_decisions d WHERE d.id = ${d.id}`);
    await handle.db.execute(sql`
      INSERT INTO access_requests SELECT (jsonb_populate_record(NULL::access_requests, to_jsonb(q)
        || jsonb_build_object('id', gen_random_uuid(), 'agent_run_id', ${newRun}::uuid,
             'access_decision_id', ${newDecision}::uuid, 'external_operation_id', NULL,
             'approval_id', NULL, 'provisioning_operation_id', NULL, 'provider_subject_id', NULL,
             'provider_target_id', NULL, 'provisioned_at', NULL, 'provisioning_error_code', NULL,
             'provider_state', NULL, 'provider_evidence', NULL, 'orchestration_blocker', NULL,
             'blocker_class', NULL, 'next_reconcile_at', NULL, 'last_coordinated_at', NULL,
             'manual_completed_by', NULL, 'manual_evidence', NULL,
             'status', CASE WHEN q.authorized_via IS NOT NULL THEN 'READY_FOR_PROVISIONING'
                            ELSE q.status::text END))).*
      FROM access_requests q WHERE q.access_decision_id = ${d.id}`);
  }
  return newRun;
}

describe("provisioning plan", () => {
  it("is created with M6B's authorization-complete transition, bound to that exact run, with a wake", async () => {
    const w = world();
    const a = await authorized(w, [OKTA]);
    const plans = await plansOf(a.workflowId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      agentRunId: a.agentRunId,
      status: "ACTIVE",
      createdVia: "AUTHORIZATION",
      catalogVersion: "1.0.0",
      catalogHash: catalogs.current.catalogHash,
      policyVersion: policies.current.policyVersion,
      policyHash: policies.current.policyHash,
      completedAt: null,
    });
    expect(await auditsOf(a.workflowId, "provisioning.plan_created")).toHaveLength(1);
    expect(await wakesOf(a.workflowId, "PLAN_CREATED")).toHaveLength(1);
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
  });

  it("allows one ACTIVE plan per workflow and never lets another run replace it", async () => {
    const w = world();
    const a = await authorized(w, [OKTA]);
    const other = await cloneRun(a.agentRunId);
    const [plan] = await plansOf(a.workflowId);
    const conflict = handle.db.transaction((tx) =>
      createProvisioningPlan(
        tx,
        { ...plan!, workflowId: a.workflowId, agentRunId: other },
        "AUTHORIZATION",
      ),
    );
    await expect(conflict).rejects.toMatchObject({ code: "PROVISIONING_PLAN_CONFLICT" });
    await expect(
      handle.db.insert(workflowProvisioningPlans).values({
        workflowId: a.workflowId,
        agentRunId: other,
        catalogVersion: "1.0.0",
        catalogHash: plan!.catalogHash,
        policyVersion: plan!.policyVersion,
        policyHash: plan!.policyHash,
        createdVia: "AUTHORIZATION",
      }),
    ).rejects.toThrow();
    expect(await plansOf(a.workflowId)).toMatchObject([{ agentRunId: a.agentRunId }]);
  });

  it("isolates historical agent runs: only the plan's run is provisioned", async () => {
    const w = world();
    const a = await authorized(w, [OKTA]);
    const historical = await cloneRun(a.agentRunId);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect(result).toMatchObject({ agentRunId: a.agentRunId, outcome: "COMPLETED" });
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
    const untouched = await rowFor(historical, OKTA);
    expect(untouched).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      provisioningOperationId: null,
      orchestrationBlocker: null,
      lastCoordinatedAt: null,
    });
    expect(w.okta.adds).toBe(1);
  });

  it("legacy workflows: exactly one candidate run is adopted; several fail closed without provider calls", async () => {
    const w = world();
    const single = await authorized(w, [OKTA]);
    await handle.db
      .delete(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, single.workflowId));
    const adopted = await coordinatorFor(w).coordinateProvisioning({
      workflowId: single.workflowId,
    });
    expect(adopted).toMatchObject({ agentRunId: single.agentRunId, outcome: "COMPLETED" });
    expect((await plansOf(single.workflowId))[0]).toMatchObject({ createdVia: "LEGACY_ADOPTION" });

    const w2 = world();
    const amb = await authorized(w2, [OKTA]);
    await cloneRun(amb.agentRunId);
    await handle.db
      .delete(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, amb.workflowId));
    const c = coordinatorFor(w2);
    const result = await c.coordinateProvisioning({ workflowId: amb.workflowId });
    expect(result).toMatchObject({
      outcome: "PLAN_BLOCKED",
      planIssue: "AMBIGUOUS_PROVISIONING_PLAN",
      planId: null,
    });
    expect([w2.okta.reads, w2.okta.adds, w2.okta.creates]).toEqual([0, 0, 0]);
    expect(await plansOf(amb.workflowId)).toHaveLength(0);
    expect(await auditsOf(amb.workflowId, "provisioning.plan_ambiguous")).toHaveLength(1);
    expect(await stateOf(amb.workflowId)).toBe("PROVISIONING");
    // The reconciler doesn't keep re-waking an ambiguous workflow.
    await c.enqueueDueWakes();
    expect(await wakesOf(amb.workflowId, "LEGACY_ADOPTION")).toHaveLength(0);
  });
});

describe("dependency-aware scheduling", () => {
  it("orders dependencies first and cascades: okta, org, then team in one coordination", async () => {
    const w = world();
    const a = await authorized(w, [TEAM, OKTA, ORG], ENGINEER, w.login);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect(result.dispatchOrder.indexOf(ORG)).toBeLessThan(result.dispatchOrder.indexOf(TEAM));
    expect(result.dispatchOrder).toEqual(expect.arrayContaining([OKTA, ORG, TEAM]));
    expect(result).toMatchObject({ outcome: "COMPLETED", workflowState: "ONBOARDING_GENERATION" });
    expect((await rowsOf(a.agentRunId)).map((r) => r.status)).toEqual([
      "PROVISIONED",
      "PROVISIONED",
      "PROVISIONED",
    ]);
    expect(await auditsOf(a.workflowId, "provisioning.request_dispatched")).toHaveLength(3);
  });

  it("never invents a missing dependency: the team is blocked with zero GitHub calls", async () => {
    const w = world();
    const a = await authorized(w, [TEAM, OKTA], ENGINEER, w.login);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.agentRunId, TEAM)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      orchestrationBlocker: "MISSING_AUTHORIZED_DEPENDENCY",
      blockerClass: "DETERMINISTIC_FAILURE",
      nextReconcileAt: null,
    });
    expect(ghCalls(w)).toBe(0);
    expect((await rowsOf(a.agentRunId)).map((r) => r.resourceId).sort()).toEqual(
      [OKTA, TEAM].sort(),
    );
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
    expect(result).toMatchObject({ outcome: "IN_PROGRESS", workflowState: "PROVISIONING" });
    expect(await auditsOf(a.workflowId, "provisioning.blocked")).toHaveLength(1);
  });

  it("lets Okta progress while GitHub waits on a pending invitation (workflow stays PROVISIONING)", async () => {
    const w = world({ inviteActivates: false });
    const a = await authorized(w, [OKTA, ORG, TEAM], ENGINEER, w.login);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
    expect(await rowFor(a.agentRunId, ORG)).toMatchObject({
      status: "PROVISIONING",
      providerState: "INVITATION_PENDING",
      orchestrationBlocker: "GITHUB_INVITATION_PENDING",
      blockerClass: "WAITING",
    });
    expect(await rowFor(a.agentRunId, TEAM)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      orchestrationBlocker: "DEPENDENCIES_NOT_READY",
    });
    expect(result).toMatchObject({ outcome: "IN_PROGRESS", workflowState: "PROVISIONING" });
    expect(w.gh.writes).toBe(1);
  });
});

describe("GitHub waits: HR claim and invitation", () => {
  it("claim required: recoverable, zero GitHub calls, no polling; the HR claim's wake resumes it", async () => {
    const w = world();
    const a = await authorized(w, [ORG, TEAM]);
    const c = coordinatorFor(w);
    await drainWakes(c);
    expect(await rowFor(a.agentRunId, ORG)).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      orchestrationBlocker: "GITHUB_IDENTITY_CLAIM_REQUIRED",
      blockerClass: "WAITING",
      nextReconcileAt: null,
      provisioningErrorCode: null,
    });
    expect(ghCalls(w)).toBe(0);
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 0 }); // no busy loop
    await claim(a.workflowId, w.login);
    expect(await wakesOf(a.workflowId, "GITHUB_IDENTITY_RECORDED")).toHaveLength(1);
    await claim(a.workflowId, w.login); // identical: no new wake
    expect(await wakesOf(a.workflowId, "GITHUB_IDENTITY_RECORDED")).toHaveLength(1);
    await drainWakes(c);
    expect((await rowsOf(a.agentRunId)).map((r) => r.status)).toEqual([
      "PROVISIONED",
      "PROVISIONED",
    ]);
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("invitation pending: scheduled reconciliation (no busy loop), then acceptance lets the team proceed", async () => {
    const w = world({ inviteActivates: false });
    const a = await authorized(w, [ORG, TEAM], ENGINEER, w.login);
    const c = coordinatorFor(w, { reconcileIntervalMs: 600_000 });
    await drainWakes(c);
    const pending = await rowFor(a.agentRunId, ORG);
    expect(pending).toMatchObject({ orchestrationBlocker: "GITHUB_INVITATION_PENDING" });
    const delay = pending.nextReconcileAt!.getTime() - Date.now();
    expect(delay).toBeGreaterThan(590_000);
    expect(delay).toBeLessThanOrEqual(600_000);
    expect((await plansOf(a.workflowId))[0]!.nextReconcileAt).not.toBeNull();

    const calls = ghCalls(w);
    await c.coordinateProvisioning({ workflowId: a.workflowId }); // an unrelated wake
    expect(ghCalls(w)).toBe(calls); // not due: no GitHub call
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 0 });

    w.gh.acceptInvitation(w.user.id); // employee accepts; no callback reaches us
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accessRequests.id, a.ids[ORG]!));
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 1 });
    expect(await c.enqueueDueWakes()).toEqual({ enqueued: 0 }); // same bucket: de-duplicated
    await drainWakes(c);
    expect((await rowsOf(a.agentRunId)).map((r) => r.status)).toEqual([
      "PROVISIONED",
      "PROVISIONED",
    ]);
    expect(w.gh.writes).toBe(2); // one invitation (never re-sent) + one team write
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(await auditsOf(a.workflowId, "provisioning.dependency_satisfied")).toHaveLength(1);
  });

  it("transient provider failure is retried on schedule, not immediately", async () => {
    const w = world();
    w.okta.addBehaviors.push("429");
    const a = await authorized(w, [OKTA]);
    const c = coordinatorFor(w, { retryDelayMs: 600_000 });
    await c.coordinateProvisioning({ workflowId: a.workflowId });
    const row = await rowFor(a.agentRunId, OKTA);
    expect(row).toMatchObject({
      orchestrationBlocker: "TRANSIENT_PROVIDER_FAILURE",
      blockerClass: "RETRYABLE",
    });
    expect(row.nextReconcileAt!.getTime() - Date.now()).toBeGreaterThan(590_000);
    const adds = w.okta.adds;
    await c.coordinateProvisioning({ workflowId: a.workflowId });
    expect(w.okta.adds).toBe(adds);
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accessRequests.id, row.id));
    expect((await c.coordinateProvisioning({ workflowId: a.workflowId })).outcome).toBe(
      "COMPLETED",
    );
  });
});

describe("manual and unsupported providers", () => {
  it("MANUAL blocks the workflow until an authorized operator completes it; then the wake advances it", async () => {
    const w = world();
    const a = await authorized(w, [ORG, MANUAL], ENGINEER, w.login);
    const c = coordinatorFor(w);
    await drainWakes(c);
    expect((await rowFor(a.agentRunId, ORG)).status).toBe("PROVISIONED");
    expect(await rowFor(a.agentRunId, MANUAL)).toMatchObject({
      status: "MANUAL_ACTION_REQUIRED",
      orchestrationBlocker: "MANUAL_ACTION_REQUIRED",
      blockerClass: "MANUAL",
      nextReconcileAt: null,
    });
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
    expect(await auditsOf(a.workflowId, "provisioning.manual_action_required")).toHaveLength(1);

    const manual = createManualProvisioningService(handle.db, { catalogs });
    const done = await manual.completeManualResource({
      accessRequestId: a.ids[MANUAL]!,
      operatorId: OPERATOR,
      evidence: "Seat assigned in Cursor admin, ticket ABC-123",
    });
    expect(done).toMatchObject({ status: "PROVISIONED", changed: true, completedBy: OPERATOR });
    expect(await rowFor(a.agentRunId, MANUAL)).toMatchObject({
      status: "PROVISIONED",
      manualCompletedBy: OPERATOR,
      manualEvidence: "Seat assigned in Cursor admin, ticket ABC-123",
      orchestrationBlocker: null,
      provisioningOperationId: null,
    });
    const [audit] = await auditsOf(a.workflowId, "provisioning.manual_resource_completed");
    expect(audit).toMatchObject({ actor: `hr:${OPERATOR}` });
    expect(await wakesOf(a.workflowId, "MANUAL_RESOURCE_COMPLETED")).toHaveLength(1);
    // Identical repeat: idempotent. Different evidence: history is not rewritten.
    expect(
      await manual.completeManualResource({
        accessRequestId: a.ids[MANUAL]!,
        operatorId: OPERATOR,
        evidence: "Seat assigned in Cursor admin, ticket ABC-123",
      }),
    ).toMatchObject({ changed: false });
    await expect(
      manual.completeManualResource({
        accessRequestId: a.ids[MANUAL]!,
        operatorId: OPERATOR,
        evidence: "Different evidence entirely",
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ALREADY_COMPLETED" });
    await drainWakes(c);
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect((await plansOf(a.workflowId))[0]).toMatchObject({ status: "COMPLETE" });
  });

  it("manual completion refuses non-MANUAL providers, other runs, wrong states and unsafe evidence", async () => {
    const w = world();
    const a = await authorized(w, [OKTA, MANUAL]);
    const manual = createManualProvisioningService(handle.db, { catalogs });
    const attempt = (accessRequestId: string, evidence = "Assigned under ticket ABC-123") =>
      manual.completeManualResource({ accessRequestId, operatorId: OPERATOR, evidence });
    await expect(attempt(a.ids[OKTA]!)).rejects.toMatchObject({ code: "PROVIDER_NOT_MANUAL" });
    // Still READY (the coordinator hasn't run): not awaiting manual action yet.
    await expect(attempt(a.ids[MANUAL]!)).rejects.toMatchObject({
      code: "NOT_AWAITING_MANUAL_ACTION",
    });
    await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    for (const evidence of [
      "short",
      "password=hunter2 for the seat",
      "Bearer abcdefghijklmnop",
      "x".repeat(501),
    ]) {
      await expect(attempt(a.ids[MANUAL]!, evidence)).rejects.toBeInstanceOf(ManualCompletionError);
    }
    const historical = await cloneRun(a.agentRunId);
    const cloned = await rowFor(historical, MANUAL);
    await handle.db
      .update(accessRequests)
      .set({ status: "MANUAL_ACTION_REQUIRED" })
      .where(eq(accessRequests.id, cloned.id));
    await expect(attempt(cloned.id)).rejects.toMatchObject({ code: "NOT_IN_ACTIVE_PLAN" });
    await expect(attempt(randomUUID())).rejects.toMatchObject({ code: "ACCESS_REQUEST_NOT_FOUND" });
    expect((await rowFor(a.agentRunId, MANUAL)).status).toBe("MANUAL_ACTION_REQUIRED");
  });

  it("a SERVICENOW resource without a configured fulfillment service is blocked, never PROVISIONED, with no external writes", async () => {
    const w = world();
    const a = await authorized(w, ["slack-engineering"]);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.agentRunId, "slack-engineering")).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      orchestrationBlocker: "PROVIDER_NOT_CONFIGURED",
      blockerClass: "DETERMINISTIC_FAILURE",
    });
    expect(result).toMatchObject({ outcome: "IN_PROGRESS", workflowState: "PROVISIONING" });
    expect(
      await handle.db
        .select()
        .from(externalOperations)
        .where(eq(externalOperations.workflowId, a.workflowId)),
    ).toHaveLength(0);
    // (M10) Configuration is fixed by a redeploy: the blocker is re-checked on the reconcile
    // interval (the sweep then wakes the plan), not left waiting for an event that never comes.
    const row = await rowFor(a.agentRunId, "slack-engineering");
    expect(row.nextReconcileAt).not.toBeNull();
    expect(row.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now() + 500_000);
    // A row blocked before this rule (no schedule) is still swept as due.
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: null })
      .where(eq(accessRequests.id, row.id));
    await coordinatorFor(w).enqueueDueWakes();
    const wakes = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, a.workflowId),
          sql`${outboxEvents.payload}->>'reason' = 'SCHEDULED_RECONCILIATION'`,
        ),
      );
    expect(wakes).toHaveLength(1);
    // Leave nothing globally due behind: the sweep is shared by later test files.
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() + interval '1 day'` })
      .where(eq(accessRequests.id, row.id));
  });
});

describe("workflow completion predicate", () => {
  it("PROVISIONING_FAILED blocks advancement without failing the workflow", async () => {
    const w = world();
    w.gh.orgMembers.set(w.user.id, { state: "active", role: "admin" });
    const a = await authorized(w, [ORG], ENGINEER, w.login);
    const result = await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
    expect(await rowFor(a.agentRunId, ORG)).toMatchObject({
      status: "PROVISIONING_FAILED",
      provisioningErrorCode: "GITHUB_UNEXPECTED_ROLE",
      orchestrationBlocker: "PROVISIONING_FAILED",
      blockerClass: "DETERMINISTIC_FAILURE",
    });
    expect(result).toMatchObject({ outcome: "IN_PROGRESS", workflowState: "PROVISIONING" });
  });

  it("zero resources: vacuously complete, exactly once", async () => {
    const w = world();
    const a = await authorized(w, []);
    const c = coordinatorFor(w);
    expect(await c.coordinateProvisioning({ workflowId: a.workflowId })).toMatchObject({
      outcome: "COMPLETED",
      workflowState: "ONBOARDING_GENERATION",
      transitioned: true,
    });
    expect(await c.coordinateProvisioning({ workflowId: a.workflowId })).toMatchObject({
      outcome: "ALREADY_COMPLETE",
      transitioned: false,
    });
    expect(await completionTransitions(a.workflowId)).toHaveLength(1);
  });

  it("all denied or rejected: nothing to provision, the stage completes (not FAILED)", async () => {
    const w = world();
    const denied = await authorized(w, ["aws-prod"], CONTRACTOR);
    expect((await rowFor(denied.agentRunId, "aws-prod")).status).toBe("DENIED");
    await drainWakes(coordinatorFor(w));
    expect(await stateOf(denied.workflowId)).toBe("ONBOARDING_GENERATION");

    const rejected = await authorized(w, [MANUAL], CONTRACTOR);
    expect(await stateOf(rejected.workflowId)).toBe("AWAITING_APPROVAL");
    await decide(rejected, w, MANUAL, "rejected");
    expect(await wakesOf(rejected.workflowId, "APPROVAL_DECIDED")).toHaveLength(1);
    expect(await wakesOf(rejected.workflowId, "WORKFLOW_RESUMED")).toHaveLength(1);
    await drainWakes(coordinatorFor(w));
    expect(await stateOf(rejected.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("mixed settled states (PROVISIONED, DENIED, REJECTED) advance to ONBOARDING_GENERATION", async () => {
    const w = world();
    const a = await authorized(w, [ORG, TEAM, OKTA, "aws-prod", MANUAL], CONTRACTOR, w.login);
    const c = coordinatorFor(w);
    // Authorized resources proceed while the workflow awaits an unrelated approval.
    expect(await stateOf(a.workflowId)).toBe("AWAITING_APPROVAL");
    await drainWakes(c);
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
    expect(await stateOf(a.workflowId)).toBe("AWAITING_APPROVAL");
    await decide(a, w, MANUAL, "rejected");
    await drainWakes(c);
    const byResource = Object.fromEntries(
      (await rowsOf(a.agentRunId)).map((r) => [r.resourceId, r.status]),
    );
    expect(byResource).toEqual({
      [ORG]: "PROVISIONED",
      [TEAM]: "PROVISIONED",
      [OKTA]: "PROVISIONED",
      "aws-prod": "DENIED",
      [MANUAL]: "REJECTED",
    });
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(await completionTransitions(a.workflowId)).toHaveLength(1);
  });

  it("an approval that makes a resource runnable wakes provisioning in the same transaction", async () => {
    const w = world();
    const a = await authorized(w, ["aws-prod"]); // REQUIRES_APPROVAL for a full-time engineer
    await decide(a, w, "aws-prod", "approved");
    expect((await rowFor(a.agentRunId, "aws-prod")).status).toBe("READY_FOR_PROVISIONING");
    expect(await wakesOf(a.workflowId, "APPROVAL_DECIDED")).toHaveLength(1);
    await drainWakes(coordinatorFor(w));
    // aws-prod depends on aws-dev, which this plan never authorized: blocked visibly (no
    // authorization is invented) and the stage stays open. M7D covers the fulfillment path.
    expect(await rowFor(a.agentRunId, "aws-prod")).toMatchObject({
      orchestrationBlocker: "MISSING_AUTHORIZED_DEPENDENCY",
    });
    expect(await stateOf(a.workflowId)).toBe("PROVISIONING");
  });
});

describe("concurrency, delivery and recovery", () => {
  it.each([2, 6])(
    "%i concurrent coordinators: one plan, one operation per resource, one transition",
    async (n) => {
      const w = world();
      const a = await authorized(w, [OKTA, ORG, TEAM], ENGINEER, w.login);
      const results = await Promise.allSettled(
        Array.from({ length: n }, () =>
          coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId }),
        ),
      );
      for (const r of results) expect(r.status).toBe("fulfilled");
      // Anything left (a coordinator that skipped an in-flight resource) settles on the next wake.
      await coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId });
      expect(await plansOf(a.workflowId)).toHaveLength(1);
      expect(await opsOf(a.workflowId, "okta.add_group_membership")).toHaveLength(1);
      expect(await opsOf(a.workflowId, "github.ensure_org_membership")).toHaveLength(1);
      expect(await opsOf(a.workflowId, "github.ensure_team_membership")).toHaveLength(1);
      expect([w.okta.adds, w.gh.writes]).toEqual([1, 2]);
      expect(await completionTransitions(a.workflowId)).toHaveLength(1);
      expect(await auditsOf(a.workflowId, "provisioning.plan_completed")).toHaveLength(1);
    },
  );

  it("six concurrent completion attempts produce exactly one transition", async () => {
    const w = world();
    const a = await authorized(w, ["aws-prod"], CONTRACTOR); // DENIED: settled
    await Promise.all(
      Array.from({ length: 6 }, () =>
        coordinatorFor(w).coordinateProvisioning({ workflowId: a.workflowId }),
      ),
    );
    expect(await completionTransitions(a.workflowId)).toHaveLength(1);
    expect((await plansOf(a.workflowId))[0]).toMatchObject({ status: "COMPLETE" });
    expect(await auditsOf(a.workflowId, "provisioning.plan_completed")).toHaveLength(1);
  });

  it("duplicate wake events are harmless: no duplicate writes, operations or transitions", async () => {
    const w = world();
    const a = await authorized(w, [OKTA]);
    for (const key of ["dup-1", "dup-2", "dup-3"]) {
      await handle.db.insert(outboxEvents).values({
        idempotencyKey: `${OUTBOX_EVENT_TYPES.provisioningWorkflowWake}:${key}:${a.workflowId}`,
        aggregateType: "onboarding_workflow",
        aggregateId: a.workflowId,
        eventType: OUTBOX_EVENT_TYPES.provisioningWorkflowWake,
        payload: { workflowId: a.workflowId, reason: "CONTINUATION" },
      });
    }
    await drainWakes(coordinatorFor(w));
    expect(w.okta.adds).toBe(1);
    expect(await opsOf(a.workflowId, "okta.add_group_membership")).toHaveLength(1);
    expect(await completionTransitions(a.workflowId)).toHaveLength(1);
  });

  it("worker crash mid-dispatch: the redelivered wake reconciles the existing operation (no duplicate entitlement)", async () => {
    const w = world();
    let release!: () => void;
    w.okta.addBehaviors.push({ writeThenHold: new Promise<void>((r) => (release = r)) });
    const a = await authorized(w, [OKTA]);
    const crashed = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "crashing-worker",
      batchSize: 10,
      leaseMs: 30_000,
      retry: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
      handlers: createEventHandlers({ workflows, provisioning: coordinatorFor(w) }),
      logger: noopLogger,
    });
    const dying = crashed.runOnce();
    for (let i = 0; i < 100 && w.okta.adds === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(w.okta.adds).toBe(1); // the membership write happened; the process "dies" now
    // Time passes: the outbox lease, the operation's owner lease and the in-flight mark expire.
    await handle.db.execute(
      sql`UPDATE outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE aggregate_id = ${a.workflowId} AND lease_token IS NOT NULL`,
    );
    await handle.db.execute(
      sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE workflow_id = ${a.workflowId} AND owner_token IS NOT NULL`,
    );
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accessRequests.id, a.ids[OKTA]!));
    // A restarted worker (fresh process, no in-memory state) finds the same work in PostgreSQL.
    await drainWakes(coordinatorFor(w), "restarted-worker");
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
    expect(w.okta.adds).toBe(1);
    expect(await opsOf(a.workflowId, "okta.add_group_membership")).toHaveLength(1);
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    release();
    await dying; // the stale worker is fenced out and changes nothing
    expect(await completionTransitions(a.workflowId)).toHaveLength(1);
    expect(w.okta.adds).toBe(1);
  });

  it("a coordination past its deadline stops dispatching and continues in a fresh wake", async () => {
    const w = world();
    const a = await authorized(w, [OKTA]);
    const result = await coordinatorFor(w, { deadlineMs: -1 }).coordinateProvisioning({
      workflowId: a.workflowId,
    });
    expect(result).toMatchObject({ dispatchOrder: [], outcome: "IN_PROGRESS" });
    expect(await wakesOf(a.workflowId, "CONTINUATION")).toHaveLength(1);
    await drainWakes(coordinatorFor(w));
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("makes no network or model call of its own (no OpenAI): only the injected provider fakes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = world();
    const a = await authorized(w, [OKTA, ORG, TEAM, MANUAL], ENGINEER, w.login);
    await drainWakes(coordinatorFor(w));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await rowFor(a.agentRunId, OKTA)).status).toBe("PROVISIONED");
  });

  it("the plan error type is exported for callers", () => {
    expect(new ProvisioningPlanError("NO_AUTHORIZATION_RUN", "x").code).toBe(
      "NO_AUTHORIZATION_RUN",
    );
    expect(like).toBeDefined();
  });
});
