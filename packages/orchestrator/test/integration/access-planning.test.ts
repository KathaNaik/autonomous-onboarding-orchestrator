import { ModelProviderError, createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf, type ScriptedStep } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import {
  accessDecisions,
  agentRuns,
  auditEvents,
  createDatabase,
  outboxEvents,
  type DatabaseHandle,
} from "@aoo/db";
import { loadPolicyRegistry } from "@aoo/policy";
import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createAccessAuthorizationService,
  createAccessPlanningService,
  createEventHandlers,
  createExternalOperationService,
  createHrisIntakeService,
  createOutboxRunner,
  createPostgresOutboxStore,
  createRoleAccessRecommendationService,
  createWorkflowService,
  noopLogger,
  type WorkflowService,
} from "../../src/index.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const catalogs = loadCatalogRegistry();
const policies = loadPolicyRegistry(catalogs);
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("unexpected network call in access-planning tests");
});
const CONTRACTOR = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "CONTRACTOR",
} as const;

beforeAll(() => {
  handle = createDatabase(inject("databaseUrl"));
  workflows = createWorkflowService(handle.db);
});
afterAll(async () => {
  fetchSpy.mockRestore();
  await handle.close();
});
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      last_error = 'parked by test cleanup' WHERE status = 'PENDING'`);
});

function world(steps: readonly ScriptedStep[], opts: { enabled?: boolean } = {}) {
  const provider = createScriptedModelProvider(steps);
  const sn = new FakeServiceNow();
  const externalOperations = createExternalOperationService(handle.db, {
    servicenow: sn,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const planning = createAccessPlanningService(handle.db, {
    recommendations: createRoleAccessRecommendationService(handle.db, {
      agent: createRoleAccessAgent({ provider, maxAttempts: 1, sleep: async () => {} }),
      catalogs,
      leaseMs: 30_000,
    }),
    authorization: createAccessAuthorizationService(handle.db, {
      policies,
      catalogs,
      workflows,
      externalOperations,
    }),
    workflows,
    sweepIntervalMs: 600_000,
  });
  const runner = createOutboxRunner(createPostgresOutboxStore(handle.db), {
    workerId: "planning-test",
    batchSize: 10,
    leaseMs: 30_000,
    retry: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
    handlers: createEventHandlers({
      workflows,
      ...(opts.enabled !== false && { accessPlanning: planning }),
    }),
    logger: noopLogger,
    random: () => 0,
  });
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      if ((await runner.runOnce()).claimed > 0) continue;
      const [{ n }] = (
        await handle.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'PENDING' AND available_at <= clock_timestamp() + interval '1 second' AND event_type IN ('hris.offer_signed.accepted', 'access.planning.requested')`,
        )
      ).rows as [{ n: number }];
      if (n === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { provider, planning, drain, sn };
}

const hire = async () =>
  (
    await createHrisIntakeService(handle.db).acceptOfferSigned(
      newOfferSignedEvent({ ...CONTRACTOR, jobDescription: "Builds services." }),
    )
  ).workflowId;
const stateOf = async (id: string) => (await workflows.getWorkflow(id))!.workflow.state;
const planningEvents = (id: string) =>
  handle.db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, id),
        eq(outboxEvents.eventType, OUTBOX_EVENT_TYPES.accessPlanningRequested),
      ),
    );
const decisionsOf = (id: string) =>
  handle.db.select().from(accessDecisions).where(eq(accessDecisions.workflowId, id));
/** The sweep is global; keep only this workflow's recovery requests (park the others). */
async function sweepFor(
  planning: { enqueueDuePlanning(): Promise<{ enqueued: number }> },
  id: string,
) {
  await planning.enqueueDuePlanning();
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      last_error = 'parked: other workflow'
     WHERE status = 'PENDING' AND event_type = ${OUTBOX_EVENT_TYPES.accessPlanningRequested}
       AND aggregate_id <> ${id}`);
  return (await planningEvents(id)).filter(
    (e) => (e.payload as { reason: string }).reason === "SCHEDULED_RECOVERY",
  ).length;
}
const runsOf = (id: string) =>
  handle.db.select().from(agentRuns).where(eq(agentRuns.workflowId, id));

describe("(M10) automatic access planning", () => {
  it("the workflow start writes the request in the same transaction; the worker recommends and authorizes", async () => {
    const id = await hire();
    expect(await planningEvents(id)).toHaveLength(0); // nothing before the start
    const w = world([outputOf("github-org-membership", "aws-prod", "cursor-license")]);
    await w.drain();
    const [request] = await planningEvents(id);
    expect(request).toMatchObject({ status: "PROCESSED", payload: { reason: "WORKFLOW_STARTED" } });
    expect(w.provider.calls).toHaveLength(1);
    const decisions = await decisionsOf(id);
    expect(Object.fromEntries(decisions.map((d) => [d.resourceId, d.decision]))).toEqual({
      "github-org-membership": "ALLOW",
      "aws-prod": "DENY",
      "cursor-license": "REQUIRES_APPROVAL",
    });
    expect(await stateOf(id)).toBe("AWAITING_APPROVAL");
  });

  it("duplicate requests and a recovery sweep replay: one agent run, one decision per resource", async () => {
    const id = await hire();
    const w = world([outputOf("github-org-membership", "aws-dev")]);
    await w.drain();
    expect(await stateOf(id)).toBe("PROVISIONING");
    for (const key of ["dup-a", "dup-b"]) {
      await handle.db.insert(outboxEvents).values({
        idempotencyKey: `${OUTBOX_EVENT_TYPES.accessPlanningRequested}:${key}:${id}`,
        aggregateType: "onboarding_workflow",
        aggregateId: id,
        eventType: OUTBOX_EVENT_TYPES.accessPlanningRequested,
        payload: { workflowId: id, reason: "SCHEDULED_RECOVERY" },
      });
    }
    await w.drain();
    expect(w.provider.calls).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
    expect(await decisionsOf(id)).toHaveLength(2);
    // The sweep never re-requests a workflow that already left planning.
    expect(await sweepFor(w.planning, id)).toBe(2); // only the two manual duplicates above
  });

  it("a transient model outage retries through the outbox on the same run", async () => {
    const id = await hire();
    const w = world([
      new ModelProviderError("PROVIDER_UNAVAILABLE", "upstream 503"),
      outputOf("aws-dev"),
    ]);
    await w.drain();
    expect(w.provider.calls).toHaveLength(2);
    expect(await runsOf(id)).toMatchObject([{ status: "SUCCEEDED", attempts: 2 }]);
    expect(await stateOf(id)).toBe("PROVISIONING");
  });

  it("an invalid recommendation is deterministic: dead-lettered, blocked once, never re-requested", async () => {
    const id = await hire();
    const w = world([outputOf("aws-dev", "github-enterprise-admin")]);
    await w.drain();
    const [request] = await planningEvents(id);
    expect(request?.status).toBe("DEAD_LETTERED");
    expect(await decisionsOf(id)).toHaveLength(0);
    expect(await stateOf(id)).toBe("ACCESS_PLANNING");
    const blocked = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.workflowId, id), eq(auditEvents.eventType, "access_planning.blocked")),
      );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toEqual({ step: "recommend", code: "RUN_FAILED" });
    expect(await sweepFor(w.planning, id)).toBe(0);
  });

  it("disabled: the request is acknowledged without a model call; the sweep re-requests once enabled", async () => {
    const id = await hire();
    const off = world([outputOf("aws-dev")], { enabled: false });
    await off.drain();
    expect(off.provider.calls).toHaveLength(0);
    expect(await stateOf(id)).toBe("ACCESS_PLANNING");
    expect((await planningEvents(id))[0]?.status).toBe("PROCESSED");
    const on = world([outputOf("aws-dev")]);
    expect(await sweepFor(on.planning, id)).toBe(1);
    expect(await sweepFor(on.planning, id)).toBe(1); // once per bucket
    await on.drain();
    expect(await stateOf(id)).toBe("PROVISIONING");
    expect(on.provider.calls).toHaveLength(1);
  });

  it("does nothing for workflows that are not planning (no model call)", async () => {
    const id = await hire(); // still RECEIVED: no worker has started it
    const w = world([outputOf("aws-dev")]);
    expect(await w.planning.planAccess({ workflowId: id })).toMatchObject({
      outcome: "NOT_APPLICABLE",
      workflowState: "RECEIVED",
    });
    expect(w.provider.calls).toHaveLength(0);
  });

  it("made no network call (scripted model, fake ServiceNow)", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
