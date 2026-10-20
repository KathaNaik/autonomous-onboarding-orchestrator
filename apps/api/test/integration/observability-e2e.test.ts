// M9 end-to-end observability: one synthetic workflow from the signed HRIS webhook (HTTP) through
// the worker's outbox runner (Role Access Agent and plan agent scripted; fake GitHub/ServiceNow;
// MANUAL resource completed by an operator through the API) to COMPLETED, then read back through
// GET /admin/onboarding/:workflowId. An in-memory OpenTelemetry exporter checks request → outbox →
// worker trace linkage, the instrumented spans, their safe attributes, and that no secret appears.
import { createOnboardingPlanAgent, createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf, planOutputOf } from "@aoo/agents/testing";
import { CATALOG_RELEASES, CatalogRegistry } from "@aoo/catalog";
import { accessRequests, createDatabase, outboxEvents, type DatabaseHandle } from "@aoo/db";
import type { GitHubTarget } from "@aoo/github";
import {
  createAccessAuthorizationService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubProvisioningService,
  createOnboardingPlanService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  noopLogger,
} from "@aoo/orchestrator";
import { POLICY_RELEASES, PolicyRegistry } from "@aoo/policy";
import { WorkflowObservabilityViewSchema } from "@aoo/shared";
import { startInMemoryTelemetry } from "@aoo/telemetry/testing";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
// Test-only fakes shared with the orchestrator's integration suite (no provider is ever called).
import { FakeGitHub } from "../../../../packages/orchestrator/test/integration/fake-github.js";
import { FakeServiceNow } from "../../../../packages/orchestrator/test/integration/fake-servicenow.js";
import { buildApp } from "../../src/app.js";
import { TEST_SECRET, offerSignedEvent, signedRequest, testConfig } from "../helpers.js";

const ADMIN_TOKEN = "e2e-onboarding-admin-token-0123456789abcdef";
const OPENAI_LIKE = "sk-proj-E2ENOTAREALKEY0123456789abcdef";
let app: FastifyInstance;
let handle: DatabaseHandle;
let otel: ReturnType<typeof startInMemoryTelemetry>;
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("unexpected network call in the M9 end-to-end test");
});

beforeAll(async () => {
  otel = startInMemoryTelemetry("aoo-e2e");
  app = await buildApp(
    testConfig({ DATABASE_URL: inject("databaseUrl"), ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }),
  );
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await otel.stop();
});

const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "ops.e2e" };

describe("M9 end-to-end: HRIS → agent → policy → provisioning → plan → COMPLETED → operator view", () => {
  it("renders a coherent lifecycle and links the trace from the request to the worker", async () => {
    // (M14) Catalog 1.0.0 / policy 1.1.0: this flow uses aws-dev as its ServiceNow fulfillment.
    const catalogs = new CatalogRegistry({ releases: CATALOG_RELEASES, currentVersion: "1.0.0" });
    const policies = new PolicyRegistry({
      releases: POLICY_RELEASES,
      currentVersion: "1.1.0",
      catalogs,
    });
    const workflows = createWorkflowService(handle.db);
    const sn = new FakeServiceNow();
    const gh = new FakeGitHub();
    gh.inviteActivates = true;
    const login = `m9e2e-${Math.random().toString(36).slice(2, 8)}`;
    gh.seedUser(login);
    gh.seedTeam("aoo-backend", "AOO Backend");

    // 1. HRIS webhook over HTTP (request span; the outbox row carries its trace context).
    const hris = signedRequest(
      offerSignedEvent({ jobDescription: `Backend work. token ${OPENAI_LIKE}` }),
    );
    const accepted = await app.inject({
      method: "POST",
      url: "/webhooks/hris",
      payload: hris.body,
      headers: hris.headers,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    const workflowId = accepted.json().workflowId as string;
    const [hrisEvent] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, workflowId));
    const requestSpan = otel.spans().find((s) => s.name === "HTTP POST /webhooks/hris")!;
    expect(requestSpan).toBeDefined();
    expect(hrisEvent!.traceParent).toContain(requestSpan.spanContext().traceId);

    // 2. Worker: the real handler registry drives the rest.
    const extOps = createExternalOperationService(handle.db, {
      handlers: [createServiceNowFulfillmentHandler(sn), ...createGitHubHandlers(gh)],
      reconcile: { attempts: 1, delayMs: 1 },
    });
    const owner = { ownerId: "e2e-worker", leaseMs: 30_000 };
    const coordinator = createProvisioningCoordinator(handle.db, {
      catalogs,
      workflows,
      servicenow: createServiceNowFulfillmentService(handle.db, {
        catalogs,
        externalOperations: extOps,
        servicenow: sn,
        ...owner,
      }),
      github: createGitHubProvisioningService(handle.db, {
        catalogs,
        externalOperations: extOps,
        github: gh,
        targets: new Map<string, GitHubTarget>([
          [
            "github-org-membership",
            { kind: "org", resourceId: "github-org-membership", org: gh.org },
          ],
        ]),
        ...owner,
      }),
      reconcileIntervalMs: 600_000,
      fulfillmentReconcileIntervalMs: 120_000,
      retryDelayMs: 600_000,
      sweepIntervalMs: 600_000,
    });
    const planService = createOnboardingPlanService(handle.db, {
      agent: createOnboardingPlanAgent({
        provider: createScriptedModelProvider([
          planOutputOf(["aws-dev", "github-org-membership", "cursor-license"]),
        ]),
        sleep: async () => {},
      }),
      catalogs,
      policies,
      workflows,
      leaseMs: 30_000,
    });
    const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
      workerId: "e2e-worker",
      batchSize: 10,
      leaseMs: 30_000,
      retry: { maxAttempts: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
      handlers: createEventHandlers({
        workflows,
        provisioning: coordinator,
        onboardingPlans: planService,
      }),
      logger: noopLogger,
      random: () => 0,
    });
    const drain = async () => {
      for (let i = 0; i < 30; i++) if ((await runner.runOnce()).claimed === 0) return;
    };
    await drain(); // RECEIVED → ACCESS_PLANNING

    // 3. Role Access Agent (scripted) and policy authorization (the parts nothing triggers yet).
    const { agentRunId } = await createRoleAccessRecommendationService(handle.db, {
      agent: createRoleAccessAgent({
        provider: createScriptedModelProvider([
          outputOf("aws-dev", "github-org-membership", "cursor-license"),
        ]),
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

    // 4. HR records the GitHub username; the worker provisions; ServiceNow is fulfilled; an
    //    operator completes the MANUAL license through the API; the worker generates the plan.
    const claim = await app.inject({
      method: "POST",
      url: `/admin/onboarding/${workflowId}/github-identity`,
      headers: auth,
      payload: { githubLogin: login },
    });
    expect(claim.statusCode).toBe(200);
    await drain();
    for (const r of sn.records.filter((x) => x.requestKind === "fulfillment"))
      sn.setFulfillmentState(r.sysId, "fulfilled");
    await handle.db
      .update(accessRequests)
      .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accessRequests.agentRunId, agentRunId));
    await coordinator.enqueueDueWakes();
    await drain();
    const [manualReq] = await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.resourceId, "cursor-license"))
      .orderBy(sql`created_at DESC`)
      .limit(1);
    const done = await app.inject({
      method: "POST",
      url: `/admin/access-requests/${manualReq!.id}/manual-complete`,
      headers: auth,
      payload: { evidence: "License seat assigned (synthetic e2e)." },
    });
    expect(done.statusCode).toBe(200);
    await drain();
    expect((await workflows.getWorkflow(workflowId))!.workflow.state).toBe("COMPLETED");

    // 5. The operator view, over HTTP.
    const writesBefore = await handle.db.execute<{ n: string }>(
      sql`SELECT (SELECT count(*) FROM audit_events WHERE workflow_id = ${workflowId}) + (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${workflowId}) + (SELECT coalesce(sum(version), 0) FROM access_requests WHERE workflow_id = ${workflowId}) AS n`,
    );
    const res = await app.inject({
      method: "GET",
      url: `/admin/onboarding/${workflowId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const view = WorkflowObservabilityViewSchema.parse(res.json());
    const writesAfter = await handle.db.execute<{ n: string }>(
      sql`SELECT (SELECT count(*) FROM audit_events WHERE workflow_id = ${workflowId}) + (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${workflowId}) + (SELECT coalesce(sum(version), 0) FROM access_requests WHERE workflow_id = ${workflowId}) AS n`,
    );
    expect(writesAfter.rows[0]!.n).toBe(writesBefore.rows[0]!.n); // the read wrote nothing

    expect(view.workflow.state).toBe("COMPLETED");
    expect(view.roleAccessRun!.recommendations.map((r) => r.resourceId)).toEqual([
      "aws-dev",
      "cursor-license",
      "github-org-membership",
    ]);
    expect(view.policyDecisions.every((d) => d.decision === "ALLOW")).toBe(true);
    expect(view.resources.map((r) => [r.resourceId, r.status])).toEqual([
      ["aws-dev", "PROVISIONED"],
      ["cursor-license", "PROVISIONED"],
      ["github-org-membership", "PROVISIONED"],
    ]);
    expect(view.resources.find((r) => r.resourceId === "cursor-license")!.evidence).toMatchObject({
      manualCompletedBy: "ops.e2e",
    });
    expect(view.fulfillments[0]).toMatchObject({
      resourceId: "aws-dev",
      fulfillmentState: "fulfilled",
    });
    expect(view.onboardingPlan!.taskCount).toBeGreaterThanOrEqual(3);
    const types = view.timeline.map((e) => e.type);
    expect(types[0]).toBe("hris.offer.signed");
    const order = [
      "workflow.created",
      "provisioning.plan_created", // written in the authorization-complete transition
      "access.policy_evaluated",
      "resource.provisioned",
      "onboarding_plan.generated",
    ].map((t) => types.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(view.timeline.some((e) => e.toState === "COMPLETED")).toBe(true);
    expect(view.correlation.traceIds).toContain(requestSpan.spanContext().traceId);

    // 6. Spans: every instrumented boundary, request → outbox → worker linkage, safe attributes.
    const spans = otel.spans();
    const names = new Set(spans.map((s) => s.name));
    for (const name of [
      "HTTP POST /webhooks/hris",
      "outbox.process hris.offer_signed.accepted",
      "outbox.process provisioning.workflow.wake",
      "outbox.process onboarding.plan.generate",
      "provisioning.coordinate",
      "external_operation.execute",
      "agent.role_access.recommend",
      "agent.onboarding_plan.generate",
      "read_model.workflow_detail",
      "HTTP GET /admin/onboarding/:workflowId",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    // Select by attributes: the runner may also deliver other test files' leftover events.
    const hrisProcess = spans.find((s) => s.attributes["aoo.outbox.event_id"] === hrisEvent!.id)!;
    expect(hrisProcess.name).toBe("outbox.process hris.offer_signed.accepted");
    expect(hrisProcess.spanContext().traceId).toBe(requestSpan.spanContext().traceId);
    expect(hrisProcess.attributes).toMatchObject({
      "aoo.workflow.id": workflowId,
      "aoo.outbox.event_id": hrisEvent!.id,
    });
    expect(
      spans.find(
        (s) =>
          s.name === "external_operation.execute" && s.attributes["aoo.workflow.id"] === workflowId,
      )!.attributes,
    ).toMatchObject({
      "aoo.workflow.id": workflowId,
      "aoo.external_operation.id": expect.any(String),
      "aoo.provider": expect.stringMatching(/^(github|servicenow)$/),
    });
    expect(spans.find((s) => s.name === "agent.role_access.recommend")!.attributes).toMatchObject({
      "aoo.agent.run_id": agentRunId,
      "aoo.workflow.id": workflowId,
    });
    expect(
      spans.find((s) => s.name === "agent.onboarding_plan.generate")!.attributes,
    ).toMatchObject({
      "aoo.workflow.id": workflowId,
      "aoo.onboarding_plan.run_id": view.onboardingPlan!.runId,
    });
    const serialized = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    for (const secret of [ADMIN_TOKEN, TEST_SECRET, OPENAI_LIKE, "Bearer "]) {
      expect(serialized).not.toContain(secret);
    }
    for (const s of spans) {
      for (const key of Object.keys(s.attributes)) expect(key).toMatch(/^(aoo\.|http\.)/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GET /admin/onboarding lists the workflow; auth failures reveal nothing", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/admin/onboarding?limit=5",
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const headers of [{}, { authorization: "Bearer wrong-token-000000000000000000000000" }]) {
      const a = await app.inject({ method: "GET", url: `/admin/onboarding/${unknown}`, headers });
      const b = await app.inject({
        method: "GET",
        url: `/admin/onboarding/${list.json().items[0].workflowId}`,
        headers,
      });
      expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
      expect(a.json()).toEqual(b.json()); // existence is not revealed
    }
    const missing = await app.inject({
      method: "GET",
      url: `/admin/onboarding/${unknown}`,
      headers: auth,
    });
    expect([missing.statusCode, missing.json().error]).toEqual([404, "WORKFLOW_NOT_FOUND"]);
  });
});
