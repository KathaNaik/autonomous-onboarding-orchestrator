// Explicit live M8 test: `pnpm test:onboarding-plan:live`. Calls the REAL OpenAI Responses API
// (OPENAI_API_KEY from the git-ignored .env; never printed). Without configuration it fails with
// LIVE_ONBOARDING_PLAN_BLOCKED before anything is written.
//
// A synthetic contractor is settled through the real HRIS intake, Role Access Agent service
// (scripted recommendations), policy engine, M7C coordinator and M7B/M7D services, with FAKE
// GitHub and ServiceNow adapters: no real provider writes (those are verified by M7A–M7D). From
// ONBOARDING_GENERATION the production worker path runs: the transactional onboarding.plan.generate
// event → outbox runner → OnboardingPlanService → real OpenAI → validation → accepted plan →
// COMPLETED. A fetch spy proves every HTTP call went to OpenAI only.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createOnboardingPlanAgent,
  createOnboardingPlanProviderFromConfig,
  createRoleAccessAgent,
  loadOnboardingPlanAgentConfig,
  type ModelProvider,
} from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  auditEvents,
  createDatabase,
  externalIdentities,
  externalOperations,
  onboardingPlanRuns,
  onboardingPlans,
  outboxEvents,
  workflowProvisioningPlans,
  type DatabaseHandle,
} from "@aoo/db";
import { createTestDatabase, type TestDatabase } from "@aoo/db/testing";
import type { GitHubTarget } from "@aoo/github";
import { loadPolicyRegistry } from "@aoo/policy";
import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccessAuthorizationService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubIdentityService,
  createGitHubProvisioningService,
  createHrisIntakeService,
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
import { FakeGitHub } from "../integration/fake-github.js";
import { FakeServiceNow } from "../integration/fake-servicenow.js";
import { newOfferSignedEvent } from "../integration/helpers.js";

const ORG = "github-org-membership";
const TEAM = "github-team-backend";
const DEV = "aws-dev";
const PROD = "aws-prod";
export const LIVE_REPORT = join(tmpdir(), "aoo-m8-onboarding-plan-live-report.json");

let testDb: TestDatabase;
let handle: DatabaseHandle;
let workflows: WorkflowService;
let openAiCalls = 0;
let apiOrigin: string;
const hosts: string[] = [];
const catalogs = loadCatalogRegistry();
const policies = loadPolicyRegistry(catalogs);

function blocked(reason: string): never {
  throw new Error(`LIVE_ONBOARDING_PLAN_BLOCKED: ${reason}`);
}

let service: OnboardingPlanService;

beforeAll(async () => {
  let config;
  try {
    config = loadOnboardingPlanAgentConfig(process.env); // errors name variables, never values
  } catch (err) {
    blocked((err as Error).message);
  }
  apiOrigin = new URL(config.OPENAI_BASE_URL).origin;
  // Record the origin of every outbound HTTP call (never headers or bodies).
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    hosts.push(
      new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        .origin,
    );
    return realFetch(input, init);
  });
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
  workflows = createWorkflowService(handle.db);
  const real = createOnboardingPlanProviderFromConfig(config);
  const counted: ModelProvider = {
    provider: real.provider,
    model: real.model,
    configId: real.configId,
    generate: (request, options) => (openAiCalls++, real.generate(request, options)),
  };
  service = createOnboardingPlanService(handle.db, {
    agent: createOnboardingPlanAgent({
      provider: counted,
      maxAttempts: config.ONBOARDING_PLAN_AGENT_MAX_ATTEMPTS,
    }),
    catalogs,
    policies,
    workflows,
    ownerId: "m8-live-worker",
    leaseMs: 180_000,
  });
});

afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

describe("live M8: worker-driven onboarding plan with the real OpenAI model", () => {
  it("ONBOARDING_GENERATION → outbox → real OpenAI → validated plan → COMPLETED; replay makes 0 calls", async () => {
    // --- Setup: settle a realistic mixed plan (no real provider writes) ---------------------
    const gh = new FakeGitHub();
    gh.inviteActivates = true;
    const login = `m8-live-${randomUUID().slice(0, 8)}`;
    gh.seedUser(login);
    gh.seedTeam("aoo-backend", "AOO Backend");
    const sn = new FakeServiceNow();
    const event = newOfferSignedEvent({
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SOFTWARE_ENGINEER",
      employmentType: "CONTRACTOR",
      role: "Backend Software Engineer (contract)",
      jobDescription:
        "Contract backend engineer building internal APIs and services with the platform team. Works in the development environment; production operations are handled by the SRE team.",
    });
    const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "m8-live",
    });
    const { agentRunId } = await createRoleAccessRecommendationService(handle.db, {
      agent: createRoleAccessAgent({
        provider: createScriptedModelProvider([outputOf(ORG, TEAM, DEV, PROD)]),
        sleep: async () => {},
      }),
      catalogs,
    }).recommendAccess({ workflowId });
    await createAccessAuthorizationService(handle.db, {
      policies,
      catalogs,
      workflows,
      externalOperations: createExternalOperationService(handle.db, { servicenow: sn }),
    }).authorizeAgentRun({ agentRunId });
    await createGitHubIdentityService(handle.db, { catalogs }).submitClaim({
      workflowId,
      githubLogin: login,
      operatorId: "m8-live-hr",
    });
    const extOps = createExternalOperationService(handle.db, {
      handlers: [createServiceNowFulfillmentHandler(sn), ...createGitHubHandlers(gh)],
      reconcile: { attempts: 1, delayMs: 1 },
    });
    const owner = { ownerId: "m8-live-provisioner", leaseMs: 30_000 };
    const coordinator = createProvisioningCoordinator(handle.db, {
      catalogs,
      workflows,
      github: createGitHubProvisioningService(handle.db, {
        catalogs,
        externalOperations: extOps,
        github: gh,
        targets: new Map<string, GitHubTarget>([
          [ORG, { kind: "org", resourceId: ORG, org: gh.org }],
          [
            TEAM,
            {
              kind: "team",
              resourceId: TEAM,
              org: gh.org,
              teamSlug: "aoo-backend",
              teamName: "AOO Backend",
            },
          ],
        ]),
        ...owner,
      }),
      servicenow: createServiceNowFulfillmentService(handle.db, {
        catalogs,
        externalOperations: extOps,
        servicenow: sn,
        ...owner,
      }),
      reconcileIntervalMs: 600_000,
      fulfillmentReconcileIntervalMs: 120_000,
      retryDelayMs: 600_000,
      sweepIntervalMs: 600_000,
    });
    for (let i = 0; i < 10 && (await stateOf(workflowId)) !== "ONBOARDING_GENERATION"; i++) {
      await coordinator.coordinateProvisioning({ workflowId });
      for (const r of sn.records.filter((x) => x.requestKind === "fulfillment"))
        sn.setFulfillmentState(r.sysId, "fulfilled");
      await handle.db
        .update(accessRequests)
        .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(accessRequests.agentRunId, agentRunId));
    }
    const settled = await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.agentRunId, agentRunId));
    const statusOf = Object.fromEntries(settled.map((r) => [r.resourceId, r.status]));
    expect(statusOf).toEqual({
      [ORG]: "PROVISIONED",
      [TEAM]: "PROVISIONED",
      [DEV]: "PROVISIONED",
      [PROD]: "DENIED",
    });
    expect(await stateOf(workflowId)).toBe("ONBOARDING_GENERATION");
    const pending = await planEvents(workflowId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "PENDING",
      payload: { reason: "PROVISIONING_SETTLED" },
    });
    expect(openAiCalls).toBe(0);
    expect(hosts).toHaveLength(0);
    const accessBefore = await accessState(workflowId);
    const providerBefore = {
      ghWrites: gh.writes,
      snPosts: sn.posts,
      ops: await opCount(workflowId),
    };

    // --- The production path: the worker's outbox runner with the real handler registry --------
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "m8-live-worker",
      batchSize: 10,
      leaseMs: 200_000,
      retry: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 5000 },
      handlers: createEventHandlers({
        workflows,
        provisioning: coordinator,
        onboardingPlans: service,
      }),
      logger: noopLogger,
    });
    await drain(runner);

    expect(await stateOf(workflowId)).toBe("COMPLETED");
    const plans = await handle.db
      .select()
      .from(onboardingPlans)
      .where(eq(onboardingPlans.workflowId, workflowId));
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    const [run] = await handle.db
      .select()
      .from(onboardingPlanRuns)
      .where(eq(onboardingPlanRuns.workflowId, workflowId));
    expect(run).toMatchObject({ status: "SUCCEEDED" });
    expect(run!.id).toBe(plan.onboardingPlanRunId);
    const [provisioningPlan] = await handle.db
      .select()
      .from(workflowProvisioningPlans)
      .where(eq(workflowProvisioningPlans.workflowId, workflowId));
    expect(run).toMatchObject({
      provisioningPlanId: provisioningPlan!.id,
      sourceAgentRunId: agentRunId,
      catalogVersion: provisioningPlan!.catalogVersion,
      catalogHash: provisioningPlan!.catalogHash,
      policyVersion: provisioningPlan!.policyVersion,
      policyHash: provisioningPlan!.policyHash,
      promptVersion: "onboarding-plan.v1",
    });
    expect(openAiCalls).toBeGreaterThanOrEqual(1);
    const callsAfterGeneration = openAiCalls;

    // --- Output safety ------------------------------------------------------------------------
    const tasks = plan.tasks as {
      phase: string;
      category: string;
      title: string;
      instruction: string;
      resourceIds: string[];
    }[];
    const referenced = [...new Set(tasks.flatMap((t) => t.resourceIds))].sort();
    for (const id of referenced) expect(statusOf[id], id).toBe("PROVISIONED");
    expect(referenced).not.toContain(PROD);
    const text = [plan.summary, ...tasks.flatMap((t) => [t.title, t.instruction])].join("\n");
    expect(text.toLowerCase()).not.toMatch(/(?<![a-z0-9-])aws-prod(?![a-z0-9-])|aws production/);
    const decisions = await handle.db
      .select()
      .from(accessDecisions)
      .where(eq(accessDecisions.workflowId, workflowId));
    const ops = await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, workflowId));
    const [identity] = await handle.db.select().from(externalIdentities);
    const internal = [
      workflowId,
      agentRunId,
      provisioningPlan!.id,
      run!.id,
      ...settled.flatMap((r) => [r.id, r.providerSubjectId ?? "", r.providerTargetId ?? ""]),
      ...decisions.flatMap((d) => [d.id, d.matchedRuleId, d.reasonCode]),
      ...ops.flatMap((o) => [
        o.id,
        o.correlationKey,
        o.externalId ?? "",
        o.externalReference ?? "",
      ]),
      identity?.providerSubjectId ?? "",
      login,
      event.employeeId,
    ].filter((t) => t.length >= 4);
    for (const t of internal)
      expect(text, `internal id leaked: ${t.slice(0, 6)}…`).not.toContain(t);
    expect(text).not.toMatch(/\b(?:https?|ftp):\/\/|\bwww\./i); // no URL
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // no e-mail
    expect(text).not.toMatch(
      /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i,
    ); // no time
    expect(text).not.toMatch(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+[A-Z]/); // no named person
    expect(text).not.toMatch(
      /\bOAR\d+|\b[0-9a-f]{32}\b|NON_EMPLOYEE|policy (?:denied|rule)|rejected by/i,
    );

    // Reads only: no authorization/provisioning writes; no provider calls during generation.
    expect(await accessState(workflowId)).toBe(accessBefore);
    expect({ ghWrites: gh.writes, snPosts: sn.posts, ops: await opCount(workflowId) }).toEqual(
      providerBefore,
    );
    expect([...new Set(hosts)]).toEqual([apiOrigin]);

    // --- Replay: duplicate event + coordinator + sweep + worker ---------------------------------
    await enqueueOnboardingPlanGeneration(handle.db, {
      workflowId,
      reason: "SCHEDULED_RECOVERY",
      key: `replay-${randomUUID()}`,
    });
    await coordinator.coordinateProvisioning({ workflowId });
    await service.enqueueDueGenerations();
    await coordinator.enqueueDueWakes();
    await drain(runner);
    const replay = await service.generatePlan({ workflowId });
    expect(replay).toMatchObject({
      outcome: "ALREADY_COMPLETED",
      onboardingPlanId: plan.id,
      modelCalls: 0,
    });
    expect(openAiCalls).toBe(callsAfterGeneration);
    const plansAfter = await handle.db
      .select()
      .from(onboardingPlans)
      .where(eq(onboardingPlans.workflowId, workflowId));
    const completions = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "workflow.transitioned"),
          eq(auditEvents.toState, "COMPLETED"),
        ),
      );
    expect(plansAfter.map((p) => p.id)).toEqual([plan.id]);
    expect(completions).toHaveLength(1);
    expect(await stateOf(workflowId)).toBe("COMPLETED");
    expect([...new Set(hosts)]).toEqual([apiOrigin]);

    const report = {
      workflowId,
      provisioningPlanId: provisioningPlan!.id,
      onboardingPlanRunId: run!.id,
      acceptedOnboardingPlanId: plan.id,
      promptVersion: run!.promptVersion,
      requestedModel: run!.model,
      servedModel: run!.servedModel,
      catalog: `${run!.catalogVersion} ${run!.catalogHash}`,
      policy: `${run!.policyVersion} ${run!.policyHash}`,
      settledResources: statusOf,
      taskCount: tasks.length,
      referencedResourceIds: referenced,
      finalWorkflowState: await stateOf(workflowId),
      latencyMs: run!.latencyMs,
      modelCalls: run!.modelCalls,
      inputTokens: run!.inputTokens,
      outputTokens: run!.outputTokens,
      providerResponseIdPresent: Boolean(run!.providerResponseId),
      openAiCallsTotal: openAiCalls,
      replay: {
        outcome: replay.outcome,
        additionalOpenAiCalls: openAiCalls - callsAfterGeneration,
        samePlanId: replay.onboardingPlanId === plan.id,
      },
      duplicatePlans: plansAfter.length - 1,
      duplicateCompletedTransitions: completions.length - 1,
      outboundOrigins: [...new Set(hosts)],
      plan: { summary: plan.summary, tasks },
    };
    writeFileSync(LIVE_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  });
});

async function stateOf(workflowId: string) {
  return (await workflows.getWorkflow(workflowId))!.workflow.state;
}
function planEvents(workflowId: string) {
  return handle.db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, workflowId),
        eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.onboardingPlanGenerate),
      ),
    );
}
async function opCount(workflowId: string) {
  return (
    await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, workflowId))
  ).length;
}
async function accessState(workflowId: string) {
  return JSON.stringify({
    d: await handle.db
      .select()
      .from(accessDecisions)
      .where(eq(accessDecisions.workflowId, workflowId))
      .orderBy(accessDecisions.id),
    r: await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.workflowId, workflowId))
      .orderBy(accessRequests.id),
  });
}
async function drain(runner: ReturnType<typeof createOutboxRunner>) {
  for (let i = 0; i < 60; i++) {
    if ((await runner.runOnce()).claimed > 0) continue;
    const [{ n }] = (
      await handle.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'PENDING'`,
      )
    ).rows as [{ n: number }];
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
