import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabase,
  externalOperations,
  accessRequests,
  outboxEvents,
  type Database,
  type DatabaseHandle,
} from "@aoo/db";
import {
  WorkflowListResponseSchema,
  WorkflowObservabilityViewSchema,
  type WorkflowObservabilityView,
} from "@aoo/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  ReadModelError,
  createWorkflowReadService,
  createWorkflowService,
} from "../../src/index.js";
import { CONTRACTOR, ENGINEER, lifecycleFor } from "./lifecycle.js";

let handle: DatabaseHandle;
let readOnly: DatabaseHandle;
let life: ReturnType<typeof lifecycleFor>;
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("unexpected network call in M9 read-model tests");
});

/** Counts query-builder calls and any write attempt on a database handle. */
function counted(db: Database) {
  const calls = { select: 0, write: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "select" || prop === "selectDistinct") calls.select++;
      if (["insert", "update", "delete", "execute", "transaction"].includes(String(prop)))
        calls.write++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as Database, calls };
}

beforeAll(() => {
  const url = inject("databaseUrl");
  handle = createDatabase(url);
  // Reads go through a connection that PostgreSQL itself makes read-only: any write would fail.
  const ro = new URL(url);
  ro.searchParams.set("options", "-c default_transaction_read_only=on");
  readOnly = createDatabase(ro.href);
  life = lifecycleFor(handle.db);
});
afterAll(async () => {
  await handle.close();
  await readOnly.close();
});
afterEach(async () => {
  await handle.db.execute(sql`
    UPDATE outbox_events SET status = 'DEAD_LETTERED', dead_lettered_at = clock_timestamp(),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE status = 'PENDING'`);
});

const reads = () => createWorkflowReadService(readOnly.db, { catalogs: life.catalogs });
const view = async (workflowId: string) => {
  const v = await reads().getWorkflowObservabilityView(workflowId);
  return WorkflowObservabilityViewSchema.parse(v); // the API contract holds
};
const resource = (v: WorkflowObservabilityView, id: string) =>
  v.resources.find((r) => r.resourceId === id)!;

describe("detail read model across the lifecycle", () => {
  it("a completed M8 workflow: every section is populated and the timeline runs HRIS → COMPLETED", async () => {
    const w = await life.build(
      ["aws-dev", "aws-prod", "github-org-membership", "github-team-backend"],
      {
        facts: CONTRACTOR,
        completePlan: true,
      },
    );
    const v = await view(w.workflowId);
    expect(v.workflow.state).toBe("COMPLETED");
    expect(v.employee).toMatchObject({
      facts: { employmentType: "CONTRACTOR" },
      jobTitle: "Backend Software Engineer",
    });
    expect(v.roleAccessRun).toMatchObject({
      status: "SUCCEEDED",
      promptVersion: "role-access.v2",
      otherRunCount: 0,
    });
    expect(v.roleAccessRun!.recommendations.map((r) => r.resourceId)).toEqual([
      "aws-dev",
      "aws-prod",
      "github-org-membership",
      "github-team-backend",
    ]);
    expect(v.policyDecisions.find((d) => d.resourceId === "aws-prod")).toMatchObject({
      decision: "DENY",
      matchedRuleId: "non-employee-production-deny",
      policyVersion: "1.1.0",
    });
    expect(resource(v, "aws-prod")).toMatchObject({
      status: "DENIED",
      settled: true,
      authorization: { decision: "DENY", outcome: "DENIED_BY_POLICY" },
    });
    expect(resource(v, "aws-dev")).toMatchObject({
      provider: "SERVICENOW",
      status: "PROVISIONED",
      authorization: { outcome: "AUTHORIZED_BY_POLICY" },
    });
    expect(resource(v, "github-team-backend")).toMatchObject({
      status: "PROVISIONED",
      dependsOn: [{ resourceId: "github-org-membership", status: "PROVISIONED" }],
      evidence: expect.objectContaining({ githubLogin: w.login, teamSlug: "aoo-backend" }),
    });
    expect(v.fulfillments).toEqual([
      expect.objectContaining({
        resourceId: "aws-dev",
        requestKind: "fulfillment",
        fulfillmentState: "fulfilled",
        localStatus: "PROVISIONED",
        verifiedFulfilledAt: expect.any(String),
        ticketNumber: expect.stringMatching(/^OAR/),
      }),
    ]);
    expect(v.externalOperations.map((o) => o.operationType).sort()).toEqual(
      [
        "github.ensure_org_membership",
        "github.ensure_team_membership",
        "servicenow.create_fulfillment_request",
      ].sort(),
    );
    expect(v.identities).toEqual([expect.objectContaining({ provider: "github", login: w.login })]);
    expect(v.githubClaim).toMatchObject({
      login: w.login,
      source: "HR_INPUT",
      recordedBy: "hr.test",
    });
    expect(v.provisioningPlan).toMatchObject({ status: "COMPLETE", agentRunId: w.agentRunId });
    expect(v.onboardingPlanRun).toMatchObject({
      status: "SUCCEEDED",
      promptVersion: "onboarding-plan.v1",
    });
    expect(v.onboardingPlan!.phases.map((p) => p.phase)).toEqual([
      "DAY_ONE",
      "FIRST_WEEK",
      "FIRST_30_DAYS",
    ]);
    expect(v.onboardingPlan!.taskCount).toBe(
      v.onboardingPlan!.phases.reduce((a, p) => a + p.tasks.length, 0),
    );
    // Timeline: starts with the HRIS event, ends with the COMPLETED transition, strictly ordered.
    const t = v.timeline;
    expect(t[0]).toMatchObject({ source: "HRIS", type: "hris.offer.signed" });
    // The accepted plan and the COMPLETED transition commit together (the plan audit row last).
    expect(t.slice(-2).map((e) => [e.type, e.toState])).toEqual([
      ["workflow.transitioned", "COMPLETED"],
      ["onboarding_plan.generated", null],
    ]);
    for (const type of [
      "workflow.created",
      "access.denied",
      "access.policy_evaluated",
      "provisioning.plan_created",
      "servicenow.fulfillment_verified",
      "github.team_membership_provisioned",
      "resource.provisioned",
      "onboarding_plan.generated",
    ]) {
      expect(
        t.some((e) => e.type === type),
        type,
      ).toBe(true);
    }
    for (let i = 1; i < t.length; i++) {
      const [a, b] = [t[i - 1]!, t[i]!];
      expect(a.occurredAt <= b.occurredAt).toBe(true);
    }
    expect(v.correlation.outboxEvents.length).toBeGreaterThan(0);
    expect(v.correlation.providerCorrelationKeys.length).toBe(3);
    expect(v.notes).toEqual([]);
  });

  it("a workflow waiting on approval shows the pending ServiceNow approval, separate from fulfillment", async () => {
    const w = await life.build(["aws-dev", "aws-prod"], { decideApprovals: false });
    const v = await view(w.workflowId);
    expect(resource(v, "aws-prod")).toMatchObject({
      status: "AWAITING_APPROVAL",
      authorization: { decision: "REQUIRES_APPROVAL", outcome: "PENDING_APPROVAL" },
      dependsOn: [{ resourceId: "aws-dev", status: expect.any(String) }],
    });
    expect(v.approvals).toEqual([
      expect.objectContaining({
        resourceId: "aws-prod",
        status: "PENDING",
        ticketNumber: expect.stringMatching(/^OAR/),
      }),
    ]);
    expect(v.fulfillments.map((f) => f.resourceId)).toEqual(["aws-dev"]); // approval ≠ fulfillment
    expect(v.onboardingPlan).toBeNull();
  });

  it("a GitHub invitation-pending workflow shows the provider state and the dependent team blocker", async () => {
    const w = await life.build(["github-org-membership", "github-team-backend"], {
      inviteActivates: false,
    });
    const v = await view(w.workflowId);
    expect(resource(v, "github-org-membership")).toMatchObject({
      status: "PROVISIONING",
      providerState: "INVITATION_PENDING",
      blocker: "GITHUB_INVITATION_PENDING",
      settled: false,
    });
    expect(resource(v, "github-team-backend")).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      blocker: "DEPENDENCIES_NOT_READY",
      dependsOn: [{ resourceId: "github-org-membership", status: "PROVISIONING" }],
    });
    expect(v.workflow.state).toBe("PROVISIONING");
  });

  it("a ServiceNow fulfillment-pending workflow: ticket created but not provisioned", async () => {
    const w = await life.build(["aws-dev"], { fulfillment: "pending" });
    const v = await view(w.workflowId);
    expect(v.fulfillments).toEqual([
      expect.objectContaining({
        fulfillmentState: "pending",
        localStatus: "PROVISIONING",
        verifiedFulfilledAt: null,
      }),
    ]);
    expect(resource(v, "aws-dev")).toMatchObject({
      blocker: "SERVICENOW_FULFILLMENT_PENDING",
      nextReconcileAt: expect.any(String),
    });
  });

  it("a PROVISIONING_FAILED resource shows its error code and blocks without failing the workflow", async () => {
    const w = await life.build(["aws-dev"], { fulfillment: "failed" });
    const v = await view(w.workflowId);
    expect(resource(v, "aws-dev")).toMatchObject({
      status: "PROVISIONING_FAILED",
      provisioningErrorCode: "SERVICENOW_FULFILLMENT_FAILED",
      settled: false,
    });
    expect(v.workflow.state).toBe("PROVISIONING");
    expect(v.fulfillments).toEqual([
      expect.objectContaining({
        fulfillmentState: "failed",
        localStatus: "PROVISIONING_FAILED",
        verifiedFulfilledAt: null,
      }),
    ]);
    const list = await reads().listWorkflows({ limit: 100 });
    const row = list.items.find((i) => i.workflowId === w.workflowId)!;
    expect(row.resourceProgress).toMatchObject({ total: 1, failed: 1, settled: 0 });
    expect(row.blockers).toEqual([
      expect.objectContaining({ resourceId: "aws-dev", status: "PROVISIONING_FAILED" }),
    ]);
  });

  it("an all-denied workflow: nothing provisioned, workflow still moves on", async () => {
    const w = await life.build(["aws-prod"], { facts: CONTRACTOR });
    const v = await view(w.workflowId);
    expect(v.resources.map((r) => [r.resourceId, r.status, r.authorization.outcome])).toEqual([
      ["aws-prod", "DENIED", "DENIED_BY_POLICY"],
    ]);
    expect(v.externalOperations).toEqual([]);
    expect(v.workflow.state).toBe("ONBOARDING_GENERATION");
    expect(v.onboardingPlan).toBeNull();
    expect(v.notes).toContain("No onboarding plan yet (not reached).");
  });

  it("a legacy workflow (no facts, no receipt, no agent run, no plan) renders with 'not reached' notes", async () => {
    const wf = await createWorkflowService(handle.db).createWorkflow({
      employee: {
        hrisEmployeeId: `LEGACY-${randomUUID().slice(0, 8)}`,
        email: `legacy.${randomUUID().slice(0, 6)}@example.com`,
        firstName: "Legacy",
        lastName: "Hire",
      },
      actor: "legacy-import",
    });
    const v = await view(wf.id);
    expect(v).toMatchObject({
      employee: { facts: null, jobTitle: null, factsSourceEventId: null },
      roleAccessRun: null,
      provisioningPlan: null,
      onboardingPlanRun: null,
      onboardingPlan: null,
      policyDecisions: [],
      resources: [],
      hrisEvents: [],
    });
    expect(v.notes).toEqual(
      expect.arrayContaining([
        "No Role Access Agent run yet (not reached).",
        "No provisioning plan yet (not reached).",
        "Employee has no canonical facts (created before M5C).",
        "No onboarding plan yet (not reached).",
      ]),
    );
    expect(v.timeline.map((e) => e.type)).toEqual(["workflow.created"]);
  });

  it("an unknown or malformed workflow id is WORKFLOW_NOT_FOUND", async () => {
    await expect(reads().getWorkflowObservabilityView(randomUUID())).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
    await expect(reads().getWorkflowObservabilityView("../etc")).rejects.toBeInstanceOf(
      ReadModelError,
    );
  });
});

describe("timeline determinism", () => {
  it("orders by occurredAt then stable id, including duplicate timestamps and historical rows", async () => {
    const w = await life.build(["aws-dev"], { provision: false });
    const at = "2020-01-01T00:00:00.000001Z";
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [...ids].reverse()) {
      await handle.db.insert(auditEvents).values({
        id,
        workflowId: w.workflowId,
        eventType: "legacy.imported",
        actor: "legacy",
        payload: { resourceId: "aws-dev", note: "not whitelisted" },
        occurredAt: new Date(at),
      } as never);
    }
    const a = await view(w.workflowId);
    const b = await view(w.workflowId);
    expect(a.timeline).toEqual(b.timeline);
    expect(a.timeline.slice(0, 3).map((e) => e.id)).toEqual(ids.map((id) => `audit:${id}`));
    expect(a.timeline[0]!.details).toEqual({ resourceId: "aws-dev" }); // only whitelisted keys
  });
});

describe("list read model", () => {
  it("paginates deterministically (updated_at DESC, id DESC) with no duplicates and filters by state", async () => {
    for (let i = 0; i < 3; i++) await life.build([], { provision: false });
    const all = WorkflowListResponseSchema.parse(await reads().listWorkflows({ limit: 100 })).items;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listWorkflows({ limit: 2, ...(cursor && { cursor }) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.workflowId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(
      all
        .map((i) => i.workflowId)
        .concat(seen.slice(all.length))
        .slice(0, seen.length),
    );
    expect(new Set(seen).size).toBe(seen.length);
    for (let i = 1; i < all.length; i++)
      expect(all[i - 1]!.updatedAt >= all[i]!.updatedAt).toBe(true);
    const completed = await reads().listWorkflows({ limit: 100, state: "COMPLETED" });
    expect(completed.items.every((i) => i.state === "COMPLETED")).toBe(true);
    await expect(reads().listWorkflows({ cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(reads().listWorkflows({ limit: 1000 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });
});

describe("read path safety", () => {
  it("makes zero writes, zero provider/model calls and a bounded number of queries (no N+1)", async () => {
    const small = await life.build(["aws-dev"], { completePlan: true });
    const big = await life.build(
      ["aws-dev", "aws-prod", "github-org-membership", "github-team-backend", "cursor-license"],
      {
        completePlan: true,
      },
    );
    const snBefore = { small: [small.sn.posts, small.sn.reads], big: [big.sn.posts, big.sn.reads] };
    const ghBefore = big.gh.writes;
    const counts = async (workflowId: string) => {
      const c = counted(readOnly.db);
      await createWorkflowReadService(c.db, {
        catalogs: life.catalogs,
      }).getWorkflowObservabilityView(workflowId);
      return c.calls;
    };
    const a = await counts(small.workflowId);
    const b = await counts(big.workflowId);
    expect(a.write + b.write).toBe(0);
    expect(b.select).toBe(a.select); // same query count regardless of resources/events
    expect(b.select).toBeLessThanOrEqual(16);
    const l = counted(readOnly.db);
    await createWorkflowReadService(l.db, { catalogs: life.catalogs }).listWorkflows({ limit: 50 });
    expect(l.calls).toEqual({ select: 5, write: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect({ small: [small.sn.posts, small.sn.reads], big: [big.sn.posts, big.sn.reads] }).toEqual(
      snBefore,
    );
    expect(big.gh.writes).toBe(ghBefore);
  });

  it("never returns secrets or raw payloads, even when durable rows contain them", async () => {
    const w = await life.build(["aws-dev"], { fulfillment: "pending" });
    const secrets = [
      "sk-proj-THISISNOTAREALKEY0123456789abcdef",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789ab",
      "SSWS 00abcdefghijklmnopqrstuvwxyz0123456789",
      "dev-only-hris-webhook-secret-change-me",
    ];
    await handle.db.insert(auditEvents).values({
      workflowId: w.workflowId,
      eventType: "test.injected",
      actor: "test",
      payload: {
        authorization: `Bearer ${secrets[0]}`,
        signature: "sha256=deadbeef",
        reason: `failed with Authorization: Bearer ${secrets[1]}`,
        rawBody: { password: secrets[3] },
      },
    });
    const [op] = await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.workflowId, w.workflowId));
    await handle.db
      .update(externalOperations)
      .set({ lastError: `HTTP 401 Authorization: ${secrets[2]} token=${secrets[0]}` })
      .where(eq(externalOperations.id, op!.id));
    await handle.db
      .update(accessRequests)
      .set({
        providerEvidence: {
          ticketNumber: "OAR0000001",
          apiToken: secrets[1],
          fulfillmentState: "pending",
        },
      })
      .where(eq(accessRequests.id, w.ids["aws-dev"]!));
    const json = JSON.stringify(await view(w.workflowId));
    for (const s of secrets) expect(json).not.toContain(s);
    for (const k of [
      "rawBody",
      "apiToken",
      "signature",
      "sha256=deadbeef",
      'request":',
      "payloadSha256",
    ]) {
      expect(json).not.toContain(k);
    }
    expect(json).toContain("OAR0000001");
  });

  it("the read connection really is read-only (a write attempt fails)", async () => {
    await expect(
      readOnly.db
        .update(outboxEvents)
        .set({ attempts: 0 })
        .where(eq(outboxEvents.id, randomUUID())),
    ).rejects.toThrow();
  });

  it("made no network call in this suite", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    void ENGINEER;
  });
});
