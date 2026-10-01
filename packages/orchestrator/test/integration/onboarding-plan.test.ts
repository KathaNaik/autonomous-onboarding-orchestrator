import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ModelProviderError,
  createOnboardingPlanAgent,
  createRoleAccessAgent,
  type ModelResponse,
} from "@aoo/agents";
import {
  createScriptedModelProvider,
  outputOf,
  planOutputOf,
  type ScriptedStep,
} from "@aoo/agents/testing";
import {
  CATALOG_RELEASES,
  CatalogRegistry,
  ResourceCatalog,
  loadCatalogRegistry,
} from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  auditEvents,
  createDatabase,
  externalOperations,
  onboardingPlanRuns,
  onboardingPlans,
  outboxEvents,
  workflowProvisioningPlans,
  type DatabaseHandle,
} from "@aoo/db";
import { loadPolicyRegistry } from "@aoo/policy";
import { OUTBOX_EVENT_TYPES, type HrisOfferSignedEvent } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createAccessAuthorizationService,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createHrisIntakeService,
  createManualProvisioningService,
  createOnboardingPlanService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  enqueueOnboardingPlanGeneration,
  noopLogger,
  type OnboardingPlanService,
  type WorkflowService,
} from "../../src/index.js";
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
const CURSOR = "cursor-license";
const mine = new Set<string>();
// M8 needs no network at all here: every model call is scripted and providers are fakes.
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("unexpected network call in M8 integration tests");
});

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

// ---------------------------------------------------------------------------------------------
// A real settled workflow: HRIS intake → Role Access Agent (scripted) → policy → approvals →
// M7C coordinator with the M7D ServiceNow executor (fake ServiceNow) and MANUAL completion.
// ---------------------------------------------------------------------------------------------

function coordinatorFor(sn: FakeServiceNow) {
  const extOps = createExternalOperationService(handle.db, {
    handlers: [createServiceNowFulfillmentHandler(sn)],
    reconcile: { attempts: 1, delayMs: 1 },
  });
  return createProvisioningCoordinator(handle.db, {
    catalogs,
    workflows,
    servicenow: createServiceNowFulfillmentService(handle.db, {
      catalogs,
      externalOperations: extOps,
      servicenow: sn,
      ownerId: "m8-test",
      leaseMs: 30_000,
    }),
    reconcileIntervalMs: 600_000,
    fulfillmentReconcileIntervalMs: 120_000,
    retryDelayMs: 600_000,
    sweepIntervalMs: 600_000,
  });
}

async function settled(
  resourceIds: string[],
  opts: {
    facts?: Partial<HrisOfferSignedEvent>;
    reject?: string[];
    jobDescription?: string;
  } = {},
) {
  const sn = new FakeServiceNow();
  const event = newOfferSignedEvent({
    ...ENGINEER,
    ...opts.facts,
    role: "Backend Software Engineer",
    jobDescription: opts.jobDescription ?? "Builds and operates backend services.",
  });
  const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  mine.add(workflowId);
  const wf = (await workflows.getWorkflow(workflowId))!.workflow;
  await workflows.transition({
    workflowId,
    to: "ACCESS_PLANNING",
    expectedVersion: wf.version,
    actor: "test",
  });
  const { agentRunId } = await createRoleAccessRecommendationService(handle.db, {
    agent: createRoleAccessAgent({
      provider: createScriptedModelProvider([outputOf(...resourceIds)]),
      sleep: async () => {},
    }),
    catalogs,
  }).recommendAccess({ workflowId });
  const snOps = createExternalOperationService(handle.db, {
    servicenow: sn,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const auth = await createAccessAuthorizationService(handle.db, {
    policies,
    catalogs,
    workflows,
    externalOperations: snOps,
  }).authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(auth.resources.map((r) => [r.resourceId, r.accessRequestId]));
  // Human approval decisions (M4C path): approve everything awaiting, except `reject`.
  const approvals = createApprovalService(handle.db, { servicenow: sn, workflows });
  for (const r of auth.resources.filter((x) => x.status === "AWAITING_APPROVAL")) {
    const done = await snOps.execute(r.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
    sn.setApprovalState(
      done.externalId,
      opts.reject?.includes(r.resourceId) ? "rejected" : "approved",
    );
    const [op] = await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, r.externalOperationId!));
    const { callbackEventId } = await approvals.recordServiceNowCallback({
      eventId: `${op!.externalId}:1`,
      instance: "dev000001",
      table: "x_0000000_autonomo_onboarding_access_request",
      sysId: op!.externalId!,
      number: op!.externalReference!,
      correlationKey: op!.correlationKey,
    });
    await approvals.processCallback(callbackEventId);
  }
  // Drive provisioning to settlement directly (the outbox carries only the plan request after).
  const coordinator = coordinatorFor(sn);
  const manual = createManualProvisioningService(handle.db, { catalogs });
  for (let i = 0; i < 10; i++) {
    await coordinator.coordinateProvisioning({ workflowId });
    if ((await stateOf(workflowId)) === "ONBOARDING_GENERATION") break;
    for (const rec of sn.records.filter((x) => x.requestKind === "fulfillment")) {
      sn.setFulfillmentState(rec.sysId, "fulfilled");
    }
    const rows = await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.agentRunId, agentRunId));
    for (const row of rows) {
      if (row.status === "MANUAL_ACTION_REQUIRED") {
        await manual.completeManualResource({
          accessRequestId: row.id,
          operatorId: "m8-test-hr",
          evidence: "License assigned by the synthetic test operator.",
        });
      }
    }
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accessRequests.agentRunId, agentRunId));
  }
  expect(await stateOf(workflowId)).toBe("ONBOARDING_GENERATION");
  const [plan] = await handle.db
    .select()
    .from(workflowProvisioningPlans)
    .where(eq(workflowProvisioningPlans.workflowId, workflowId));
  return { workflowId, agentRunId, ids, sn, coordinator, provisioningPlan: plan! };
}
type Settled = Awaited<ReturnType<typeof settled>>;

function planService(
  steps: readonly ScriptedStep[],
  opts: { leaseMs?: number; catalogs?: CatalogRegistry; ownerId?: string } = {},
) {
  const provider = createScriptedModelProvider(steps, { model: "scripted-plan-model" });
  const service = createOnboardingPlanService(handle.db, {
    agent: createOnboardingPlanAgent({ provider, maxAttempts: 3, sleep: async () => {} }),
    catalogs: opts.catalogs ?? catalogs,
    policies,
    workflows,
    ownerId: opts.ownerId ?? `plan-${randomUUID().slice(0, 6)}`,
    leaseMs: opts.leaseMs ?? 30_000,
    sweepIntervalMs: 600_000,
  });
  return { service, provider };
}

function runnerFor(
  service: OnboardingPlanService,
  s: Settled,
  opts: { workerId?: string; leaseMs?: number; backoffMs?: number; heartbeat?: false } = {},
) {
  return createOutboxRunner(createPostgresOutboxStore(handle.db), {
    workerId: opts.workerId ?? "w1",
    batchSize: 10,
    leaseMs: opts.leaseMs ?? 30_000,
    retry: {
      maxAttempts: 10,
      backoffBaseMs: opts.backoffMs ?? 1,
      backoffMaxMs: opts.backoffMs ?? 1,
    },
    handlers: createEventHandlers({
      workflows,
      provisioning: s.coordinator,
      onboardingPlans: service,
    }),
    logger: noopLogger,
    random: () => 0,
    ...(opts.heartbeat === false && { heartbeatIntervalMs: false as const }),
  });
}

async function drain(runner: ReturnType<typeof runnerFor>) {
  for (let i = 0; i < 200; i++) {
    if ((await runner.runOnce()).claimed > 0) continue;
    const [{ n }] = (
      await handle.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'PENDING'`,
      )
    ).rows as [{ n: number }];
    if (n === 0) return;
    await sleep(10);
  }
}

const stateOf = async (workflowId: string) =>
  (await workflows.getWorkflow(workflowId))!.workflow.state;
const plansOf = (workflowId: string) =>
  handle.db.select().from(onboardingPlans).where(eq(onboardingPlans.workflowId, workflowId));
const runsOf = (workflowId: string) =>
  handle.db.select().from(onboardingPlanRuns).where(eq(onboardingPlanRuns.workflowId, workflowId));
const auditsOf = (workflowId: string, eventType: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), eq(auditEvents.eventType, eventType)));
const completions = (workflowId: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workflowId, workflowId),
        eq(auditEvents.eventType, "workflow.transitioned"),
        eq(auditEvents.toState, "COMPLETED"),
      ),
    );
const planEvents = (workflowId: string) =>
  handle.db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, workflowId),
        eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.onboardingPlanGenerate),
      ),
    );
/** Access-state fingerprint: every decision and request row of the workflow, all columns. */
const accessState = async (workflowId: string) =>
  JSON.stringify({
    decisions: await handle.db
      .select()
      .from(accessDecisions)
      .where(eq(accessDecisions.workflowId, workflowId))
      .orderBy(accessDecisions.id),
    requests: await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.workflowId, workflowId))
      .orderBy(accessRequests.id),
  });
const providerState = async (s: Settled) => ({
  posts: s.sn.posts,
  reads: s.sn.reads,
  ops: (
    await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, s.workflowId))
  ).length,
});

describe("automatic trigger and completion", () => {
  it("the PROVISIONING → ONBOARDING_GENERATION transaction enqueues the plan request; the worker completes the workflow", async () => {
    const s = await settled([DEV, PROD], { facts: CONTRACTOR });
    const events = await planEvents(s.workflowId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "PENDING",
      idempotencyKey: `onboarding.plan.generate:provisioning-plan:${s.provisioningPlan.id}`,
      payload: { workflowId: s.workflowId, reason: "PROVISIONING_SETTLED" },
    });

    const access = await accessState(s.workflowId);
    const providers = await providerState(s);
    const { service, provider } = planService([planOutputOf([DEV])]);
    await drain(runnerFor(service, s));

    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    const [plan] = await plansOf(s.workflowId);
    expect(plan).toMatchObject({
      provisioningPlanId: s.provisioningPlan.id,
      promptVersion: "onboarding-plan.v1",
      taskCount: 4,
    });
    expect(provider.calls).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
    expect(await auditsOf(s.workflowId, "onboarding_plan.generated")).toHaveLength(1);
    expect(await auditsOf(s.workflowId, "onboarding_plan.generation_started")).toHaveLength(1);
    // Reads only: no authorization or provisioning writes, no provider calls.
    expect(await accessState(s.workflowId)).toBe(access);
    expect(await providerState(s)).toEqual(providers);
  });

  it("persists exact provenance and the exact safe input snapshot (no internal identifiers)", async () => {
    const s = await settled([DEV, PROD], { facts: CONTRACTOR });
    const { service, provider } = planService([planOutputOf([DEV])]);
    await drain(runnerFor(service, s));

    const [run] = await runsOf(s.workflowId);
    const p = s.provisioningPlan;
    expect(run).toMatchObject({
      status: "SUCCEEDED",
      provisioningPlanId: p.id,
      sourceAgentRunId: s.agentRunId,
      catalogVersion: p.catalogVersion,
      catalogHash: p.catalogHash,
      policyVersion: p.policyVersion,
      policyHash: p.policyHash,
      promptVersion: "onboarding-plan.v1",
      servedModel: "scripted-test-model",
      providerResponseId: "resp_scripted",
      inputTokens: 1500,
      outputTokens: 400,
      modelCalls: 1,
      attempts: 1,
    });
    expect(run!.inputSnapshot).toEqual({
      employee: {
        departmentLabel: "Engineering",
        roleFamilyLabel: "Software Engineer",
        employmentTypeLabel: "Contractor",
        jobTitle: "Backend Software Engineer",
        jobDescription: "Builds and operates backend services.",
      },
      resources: [
        {
          resourceId: DEV,
          displayName: catalogs.current.getResource(DEV).displayName,
          description: catalogs.current.getResource(DEV).description,
          availability: "AVAILABLE",
        },
        {
          resourceId: PROD,
          displayName: catalogs.current.getResource(PROD).displayName,
          description: catalogs.current.getResource(PROD).description,
          availability: "NOT_AVAILABLE",
        },
      ],
    });
    // The snapshot is exactly what the model received.
    const sent = provider.calls[0]!.user;
    const payload = JSON.parse(sent.slice(sent.indexOf("{")));
    expect(payload.resources).toEqual((run!.inputSnapshot as { resources: unknown }).resources);
    // No internal identifier or policy reasoning reaches the model or the snapshot.
    const decisions = await handle.db
      .select()
      .from(accessDecisions)
      .where(eq(accessDecisions.workflowId, s.workflowId));
    const ops = await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, s.workflowId));
    const internal = [
      s.workflowId,
      s.agentRunId,
      p.id,
      ...Object.values(s.ids),
      ...decisions.flatMap((d) => [d.id, d.matchedRuleId, d.reasonCode, d.decision]),
      ...ops.flatMap((o) => [
        o.id,
        o.correlationKey,
        o.externalId ?? "",
        o.externalReference ?? "",
      ]),
      "DENIED",
      "REJECTED",
      "policy",
    ].filter((t) => t.length > 0);
    for (const text of [sent, JSON.stringify(run!.inputSnapshot)]) {
      for (const t of internal) expect(text, t).not.toContain(t);
    }
    // The internal resource snapshot keeps the audit trail outside the prompt.
    expect(run!.resourceSnapshot).toEqual([
      expect.objectContaining({
        resourceId: DEV,
        status: "PROVISIONED",
        availability: "AVAILABLE",
        accessRequestId: s.ids[DEV],
      }),
      expect.objectContaining({
        resourceId: PROD,
        status: "DENIED",
        availability: "NOT_AVAILABLE",
        accessRequestId: s.ids[PROD],
      }),
    ]);
    const accepted = await service.getAcceptedPlan(s.workflowId);
    expect(accepted).toMatchObject({
      onboardingPlanRunId: run!.id,
      provisioningPlanId: p.id,
      sourceAgentRunId: s.agentRunId,
    });
  });

  it("a MANUAL resource completed by an operator is AVAILABLE; a human-rejected one is NOT_AVAILABLE", async () => {
    const s = await settled([DEV, PROD, CURSOR], { reject: [PROD] });
    const { service } = planService([planOutputOf([DEV, CURSOR])]);
    await drain(runnerFor(service, s));
    const [run] = await runsOf(s.workflowId);
    expect(
      (
        run!.inputSnapshot as { resources: { resourceId: string; availability: string }[] }
      ).resources.map((r) => [r.resourceId, r.availability]),
    ).toEqual(
      [
        [DEV, "AVAILABLE"],
        [PROD, "NOT_AVAILABLE"],
        [CURSOR, "AVAILABLE"],
      ].sort(),
    );
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
  });
});

describe("zero-resource and all-unavailable workflows", () => {
  it("a workflow with zero access requests completes with a valid generic plan", async () => {
    const s = await settled([]);
    const { service, provider } = planService([planOutputOf()]);
    await drain(runnerFor(service, s));
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    const [run] = await runsOf(s.workflowId);
    expect((run!.inputSnapshot as { resources: unknown[] }).resources).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    expect(await plansOf(s.workflowId)).toHaveLength(1);
  });

  it("an all-denied/rejected workflow completes with a plan that references nothing", async () => {
    const s = await settled([PROD, CURSOR], { facts: CONTRACTOR, reject: [CURSOR] });
    const { service } = planService([planOutputOf()]);
    await drain(runnerFor(service, s));
    const [run] = await runsOf(s.workflowId);
    const input = run!.inputSnapshot as { resources: { availability: string }[] };
    expect(input.resources.map((r) => r.availability)).toEqual(["NOT_AVAILABLE", "NOT_AVAILABLE"]);
    const [plan] = await plansOf(s.workflowId);
    expect((plan!.tasks as { resourceIds: string[] }[]).flatMap((t) => t.resourceIds)).toEqual([]);
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
  });
});

describe("invalid model output never completes the workflow", () => {
  it.each([
    [
      "an unknown resource reference",
      planOutputOf([], {
        extraTasks: [
          {
            phase: "DAY_ONE",
            category: "ACCOUNT_SETUP",
            title: "Admin",
            instruction: "Use it.",
            resourceIds: ["aws-prod-admin"],
          },
        ],
      }),
      "INVALID_PLAN",
      "UNKNOWN_RESOURCE",
    ],
    [
      "an unavailable (denied) resource reference",
      planOutputOf([PROD]),
      "INVALID_PLAN",
      "UNAVAILABLE_RESOURCE",
    ],
    [
      "a schema violation",
      { output: { summary: "only a summary" } } as ModelResponse,
      "MALFORMED_OUTPUT",
      null,
    ],
  ])(
    "%s: bounded retries, sanitized failure, no plan, stays ONBOARDING_GENERATION",
    async (_, step, category, violation) => {
      const s = await settled([DEV, PROD], { facts: CONTRACTOR });
      const access = await accessState(s.workflowId);
      const { service, provider } = planService([step]);
      await drain(runnerFor(service, s));

      expect(provider.calls).toHaveLength(3); // bounded within the run, then final
      expect(await stateOf(s.workflowId)).toBe("ONBOARDING_GENERATION");
      expect(await plansOf(s.workflowId)).toHaveLength(0);
      const [run] = await runsOf(s.workflowId);
      expect(run).toMatchObject({
        status: "FAILED",
        errorCategory: category,
        errorRetryable: false,
        output: null,
      });
      if (violation) {
        expect(run!.errorDetail).toMatchObject({
          violations: expect.arrayContaining([expect.objectContaining({ code: violation })]),
        });
      }
      expect(JSON.stringify(run!.errorDetail)).not.toContain("Use it.");
      const [event] = await planEvents(s.workflowId);
      expect(event).toMatchObject({ status: "DEAD_LETTERED" });
      expect(await auditsOf(s.workflowId, "onboarding_plan.generation_failed")).toHaveLength(1);
      expect(await accessState(s.workflowId)).toBe(access);
      // Not re-woken forever: a permanently failed run is excluded from recovery.
      await service.enqueueDueGenerations();
      expect(await planEvents(s.workflowId)).toHaveLength(1);
    },
  );
});

describe("temporary OpenAI failures", () => {
  it("a provider outage records a retryable failure; the outbox retry then succeeds", async () => {
    const s = await settled([DEV]);
    const outage = new ModelProviderError("PROVIDER_UNAVAILABLE", "provider error: HTTP 503");
    const { service, provider } = planService([outage, outage, outage, planOutputOf([DEV])]);
    const runner = runnerFor(service, s);
    await runner.runOnce();
    expect(await stateOf(s.workflowId)).toBe("ONBOARDING_GENERATION");
    const [failed] = await runsOf(s.workflowId);
    expect(failed).toMatchObject({
      status: "FAILED",
      errorCategory: "PROVIDER_UNAVAILABLE",
      errorRetryable: true,
    });
    const [pending] = await planEvents(s.workflowId);
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1 });

    await drain(runner);
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    const runs = await runsOf(s.workflowId);
    expect(runs).toHaveLength(1); // the same logical run, reclaimed
    expect(runs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2, errorCategory: null });
    expect(provider.calls).toHaveLength(4);
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
  });

  it("an authentication failure is final for the run (no retry loop)", async () => {
    const s = await settled([DEV]);
    const { service, provider } = planService([
      new ModelProviderError("AUTHENTICATION", "authentication failed: HTTP 401"),
    ]);
    await drain(runnerFor(service, s));
    expect(provider.calls).toHaveLength(1);
    const [run] = await runsOf(s.workflowId);
    expect(run).toMatchObject({
      status: "FAILED",
      errorCategory: "AUTHENTICATION",
      errorRetryable: false,
    });
    expect(await stateOf(s.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("stores a sanitized error (no API key, no authorization header)", async () => {
    const s = await settled([DEV]);
    const key = "sk-proj-THISISNOTAREALKEY0123456789abcdef";
    const { service } = planService([
      new ModelProviderError(
        "BAD_REQUEST",
        `request rejected authorization: Bearer ${key} api_key=${key}`,
      ),
    ]);
    await drain(runnerFor(service, s));
    const [run] = await runsOf(s.workflowId);
    expect(JSON.stringify(run)).not.toContain(key);
    const [event] = await planEvents(s.workflowId);
    expect(JSON.stringify(event)).not.toContain(key);
  });
});

describe("idempotency and concurrency", () => {
  it("duplicate events: one run, one plan, one COMPLETED transition, one model call", async () => {
    const s = await settled([DEV]);
    for (let i = 0; i < 3; i++) {
      await enqueueOnboardingPlanGeneration(handle.db, {
        workflowId: s.workflowId,
        reason: "SCHEDULED_RECOVERY",
        key: `dup-${i}-${randomUUID()}`,
      });
    }
    const { service, provider } = planService([planOutputOf([DEV])]);
    await drain(runnerFor(service, s));
    expect(await planEvents(s.workflowId)).toHaveLength(4);
    expect((await planEvents(s.workflowId)).every((e) => e.status === "PROCESSED")).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(await runsOf(s.workflowId)).toHaveLength(1);
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
  });

  it.each([2, 6])(
    "%i concurrent workers (duplicate deliveries): one plan, one COMPLETED transition",
    async (n) => {
      const s = await settled([DEV]);
      for (let i = 1; i < n; i++) {
        await enqueueOnboardingPlanGeneration(handle.db, {
          workflowId: s.workflowId,
          reason: "SCHEDULED_RECOVERY",
          key: `c-${i}-${randomUUID()}`,
        });
      }
      const slow = async () => (await sleep(50), planOutputOf([DEV]));
      const workers = Array.from({ length: n }, (_, i) => {
        const { service, provider } = planService([slow], { ownerId: `worker-${i}` });
        return {
          provider,
          runner: runnerFor(service, s, { workerId: `worker-${i}`, backoffMs: 20 }),
        };
      });
      // Each worker claims one event at a time, concurrently.
      await Promise.all(
        workers.map(async (w) => {
          for (let i = 0; i < 30; i++) {
            if ((await w.runner.runOnce()).claimed === 0) await sleep(15);
            if (
              (await stateOf(s.workflowId)) === "COMPLETED" &&
              (await planEvents(s.workflowId)).every((e) => e.status !== "PENDING")
            )
              return;
          }
        }),
      );
      expect(workers.reduce((a, w) => a + w.provider.calls.length, 0)).toBe(1);
      expect(await runsOf(s.workflowId)).toHaveLength(1);
      expect(await plansOf(s.workflowId)).toHaveLength(1);
      expect(await completions(s.workflowId)).toHaveLength(1);
      expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    },
  );

  it("(M10) a model call longer than the 30 s outbox lease keeps its lease: one call, one plan, no takeover", async () => {
    const s = await settled([DEV]);
    const a = planService([async () => (await sleep(36_000), planOutputOf([DEV]))], {
      ownerId: "long-worker",
      leaseMs: 180_000,
    });
    // The production defaults: 30 s outbox lease, heartbeat every 10 s.
    const running = runnerFor(a.service, s, { workerId: "long-worker" }).runOnce();
    const b = planService([planOutputOf([DEV])], { ownerId: "poller" });
    const poller = runnerFor(b.service, s, { workerId: "poller" });
    let stolen = 0;
    let done = false;
    void running.finally(() => (done = true));
    while (!done) {
      await sleep(2_000);
      stolen += (await poller.runOnce()).claimed;
    }
    // The holder may also claim leftover provisioning wakes of the settled workflow.
    const summary = await running;
    expect(summary).toMatchObject({ leaseLost: 0, retried: 0, deadLettered: 0 });
    expect(summary.succeeded).toBe(summary.claimed);
    expect(stolen).toBe(0); // the lease never lapsed, even past 30 s
    expect(a.provider.calls).toHaveLength(1);
    expect(b.provider.calls).toHaveLength(0);
    const runs = await runsOf(s.workflowId);
    expect(runs).toMatchObject([{ status: "SUCCEEDED", attempts: 1 }]);
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
    const [event] = await planEvents(s.workflowId);
    expect(event).toMatchObject({ status: "PROCESSED", attempts: 1 });
  }, 90_000);

  it("6 concurrent direct completion attempts produce one plan and one transition", async () => {
    const s = await settled([DEV]);
    const services = Array.from({ length: 6 }, (_, i) =>
      planService([async () => (await sleep(30), planOutputOf([DEV]))], { ownerId: `direct-${i}` }),
    );
    const results = await Promise.allSettled(
      services.map((x) => x.service.generatePlan({ workflowId: s.workflowId })),
    );
    const completed = results.filter(
      (r) => r.status === "fulfilled" && r.value.outcome === "COMPLETED",
    );
    expect(completed).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ code: "BUSY", retryable: true });
    }
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
    // Replay after completion: same plan, no model call.
    const again = await services[0]!.service.generatePlan({ workflowId: s.workflowId });
    const [plan] = await plansOf(s.workflowId);
    expect(again).toMatchObject({
      outcome: "ALREADY_COMPLETED",
      onboardingPlanId: plan!.id,
      modelCalls: 0,
    });
  });

  it("worker restart: a crashed worker's event is redelivered and the run reclaimed; the stale worker writes nothing", async () => {
    const s = await settled([DEV]);
    // Worker A hangs forever inside the model call (a crash that leaves leases behind).
    const hang = () => new Promise<ModelResponse>(() => {});
    const a = planService([hang], { leaseMs: 300, ownerId: "worker-a" });
    // A crashed process renews nothing: no heartbeat.
    const runnerA = runnerFor(a.service, s, {
      workerId: "worker-a",
      leaseMs: 300,
      heartbeat: false,
    });
    void runnerA.runOnce();
    await sleep(100);
    const [claimed] = await runsOf(s.workflowId);
    expect(claimed).toMatchObject({ status: "RUNNING", ownerId: "worker-a" });
    await sleep(400); // both the outbox lease and the run lease expire

    const b = planService([planOutputOf([DEV])], { ownerId: "worker-b" });
    await drain(runnerFor(b.service, s, { workerId: "worker-b" }));
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    const runs = await runsOf(s.workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
  });

  it("a stale owner finishing late is fenced out and changes nothing", async () => {
    const s = await settled([DEV]);
    const late = planService([async () => (await sleep(400), planOutputOf([DEV]))], {
      leaseMs: 250,
      ownerId: "late",
    });
    const lateResult = late.service.generatePlan({ workflowId: s.workflowId }).catch((e) => e);
    await sleep(300);
    const fresh = planService([planOutputOf([DEV])], { ownerId: "fresh" });
    const done = await fresh.service.generatePlan({ workflowId: s.workflowId });
    expect(done.outcome).toBe("COMPLETED");
    // The stale owner either loses the fence (OWNERSHIP_LOST) or finds the plan already accepted;
    // either way it writes nothing: no second plan, transition or failure record.
    const late2 = await lateResult;
    if (late2 instanceof Error) expect(late2).toMatchObject({ code: "OWNERSHIP_LOST" });
    else
      expect(late2).toMatchObject({
        outcome: "ALREADY_COMPLETED",
        onboardingPlanRunId: done.onboardingPlanRunId,
      });
    expect(await auditsOf(s.workflowId, "onboarding_plan.generation_failed")).toHaveLength(0);
    const [finalRun] = await runsOf(s.workflowId);
    expect(finalRun).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await plansOf(s.workflowId)).toHaveLength(1);
    expect(await completions(s.workflowId)).toHaveLength(1);
    const [plan] = await plansOf(s.workflowId);
    expect(plan!.onboardingPlanRunId).toBe(done.onboardingPlanRunId);
  });

  it("missed event recovery: the sweep re-enqueues a workflow in ONBOARDING_GENERATION without a plan, once per bucket", async () => {
    const s = await settled([DEV]);
    await handle.db
      .update(outboxEvents)
      .set({ status: "DEAD_LETTERED", deadLetteredAt: sql`clock_timestamp()` as never })
      .where(eq(outboxEvents.aggregateId, s.workflowId)); // the original request is lost
    const { service } = planService([planOutputOf([DEV])]);
    await service.enqueueDueGenerations();
    await service.enqueueDueGenerations(); // same bucket: de-duplicated
    const recovery = (await planEvents(s.workflowId)).filter((e) => e.status === "PENDING");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.payload).toMatchObject({ reason: "SCHEDULED_RECOVERY" });
    await drain(runnerFor(service, s));
    expect(await stateOf(s.workflowId)).toBe("COMPLETED");
    await service.enqueueDueGenerations();
    expect((await planEvents(s.workflowId)).filter((e) => e.status === "PENDING")).toHaveLength(0);
  });
});

describe("fail closed before any model call", () => {
  it("an unresolved orchestration blocker is ONBOARDING_INPUT_NOT_SETTLED: no OpenAI call, stays ONBOARDING_GENERATION", async () => {
    const s = await settled([DEV, PROD], { facts: CONTRACTOR });
    await handle.db
      .update(accessRequests)
      .set({ orchestrationBlocker: "DEPENDENCIES_NOT_READY", blockerClass: "WAITING" })
      .where(eq(accessRequests.id, s.ids[PROD]!));
    const { service, provider } = planService([planOutputOf([DEV])]);
    await expect(service.generatePlan({ workflowId: s.workflowId })).rejects.toMatchObject({
      code: "ONBOARDING_INPUT_NOT_SETTLED",
      blocked: true,
      retryable: false,
    });
    await drain(runnerFor(service, s));
    expect(provider.calls).toHaveLength(0);
    expect(await runsOf(s.workflowId)).toHaveLength(0);
    expect(await stateOf(s.workflowId)).toBe("ONBOARDING_GENERATION");
    const [blocked] = await auditsOf(s.workflowId, "onboarding_plan.generation_blocked");
    expect(blocked!.payload).toMatchObject({
      code: "ONBOARDING_INPUT_NOT_SETTLED",
      unsettled: [{ resourceId: PROD, status: "DENIED" }],
    });
    await service.enqueueDueGenerations();
    expect((await planEvents(s.workflowId)).filter((e) => e.status === "PENDING")).toHaveLength(0);
  });

  it("uses the plan's exact historical catalog: a hash mismatch or missing release fails closed", async () => {
    const s = await settled([DEV]);
    const base = CATALOG_RELEASES[0]!;
    const altered = structuredClone(base.document) as {
      resources: { resourceId: string; description: string }[];
    };
    altered.resources.find((r) => r.resourceId === DEV)!.description = "Altered.";
    const mismatch = planService([planOutputOf([DEV])], {
      catalogs: new CatalogRegistry({
        releases: [{ document: altered, catalogHash: new ResourceCatalog(altered).catalogHash }],
        currentVersion: "1.0.0",
      }),
    });
    await expect(mismatch.service.generatePlan({ workflowId: s.workflowId })).rejects.toMatchObject(
      { code: "CATALOG_HASH_MISMATCH" },
    );
    const other = structuredClone(altered) as unknown as { catalogVersion: string };
    other.catalogVersion = "9.9.9";
    const unknown = planService([planOutputOf([DEV])], {
      catalogs: new CatalogRegistry({
        releases: [{ document: other, catalogHash: new ResourceCatalog(other).catalogHash }],
        currentVersion: "9.9.9",
      }),
    });
    await expect(unknown.service.generatePlan({ workflowId: s.workflowId })).rejects.toMatchObject({
      code: "CATALOG_UNAVAILABLE",
    });
    expect(mismatch.provider.calls.length + unknown.provider.calls.length).toBe(0);
    expect(await stateOf(s.workflowId)).toBe("ONBOARDING_GENERATION");
  });

  it("inconsistent access-request ownership fails closed", async () => {
    const s = await settled([DEV]);
    const other = await settled([]);
    await handle.db
      .update(accessRequests)
      .set({ workflowId: other.workflowId })
      .where(eq(accessRequests.id, s.ids[DEV]!));
    const { service, provider } = planService([planOutputOf([DEV])]);
    await expect(service.generatePlan({ workflowId: s.workflowId })).rejects.toMatchObject({
      code: "ACCESS_REQUEST_OWNERSHIP_MISMATCH",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("a workflow in ONBOARDING_GENERATION without a provisioning plan fails closed", async () => {
    const event = newOfferSignedEvent({ ...ENGINEER });
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
    for (const to of [
      "ACCESS_PLANNING",
      "POLICY_REVIEW",
      "PROVISIONING",
      "ONBOARDING_GENERATION",
    ] as const) {
      const wf = (await workflows.getWorkflow(workflowId))!.workflow;
      await workflows.transition({ workflowId, to, expectedVersion: wf.version, actor: "test" });
    }
    const { service, provider } = planService([planOutputOf()]);
    await expect(service.generatePlan({ workflowId })).rejects.toMatchObject({
      code: "PROVISIONING_PLAN_MISSING",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("does nothing for workflows that aren't in ONBOARDING_GENERATION", async () => {
    const event = newOfferSignedEvent({ ...ENGINEER });
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
    const { service, provider } = planService([planOutputOf()]);
    expect(await service.generatePlan({ workflowId })).toMatchObject({
      outcome: "NOT_APPLICABLE",
      workflowState: "RECEIVED",
    });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("invariants", () => {
  it("accepted plans are append-only", async () => {
    const s = await settled([DEV]);
    const { service } = planService([planOutputOf([DEV])]);
    await drain(runnerFor(service, s));
    await expect(
      handle.db.execute(
        sql`UPDATE onboarding_plans SET summary = 'x' WHERE workflow_id = ${s.workflowId}`,
      ),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`DELETE FROM onboarding_plans WHERE workflow_id = ${s.workflowId}`),
    ).rejects.toThrow();
    expect(await plansOf(s.workflowId)).toHaveLength(1);
  });

  it("every COMPLETED workflow of this suite has exactly one accepted plan, and one COMPLETED transition", async () => {
    let completedCount = 0;
    for (const workflowId of mine) {
      if ((await stateOf(workflowId)) !== "COMPLETED") continue;
      completedCount++;
      expect(await plansOf(workflowId), workflowId).toHaveLength(1);
      expect(await completions(workflowId), workflowId).toHaveLength(1);
    }
    expect(completedCount).toBeGreaterThan(5);
  });

  it("made no network call (no OpenAI, ServiceNow, Okta or GitHub HTTP) in this suite", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
