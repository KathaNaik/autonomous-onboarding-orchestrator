import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { CATALOG_RELEASES, CatalogRegistry, ResourceCatalog } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  agentRuns,
  approvals,
  auditEvents,
  createDatabase,
  externalOperations,
  type DatabaseHandle,
} from "@aoo/db";
import { POLICY_RELEASES, PolicyEngine, PolicyRegistry } from "@aoo/policy";
import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  ROLE_FAMILY_CODES,
  type HrisOfferSignedEvent,
} from "@aoo/shared";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AuthorizationError,
  createAccessAuthorizationService,
  createApprovalService,
  createExternalOperationService,
  createHrisIntakeService,
  createRoleAccessRecommendationService,
  createWorkflowService,
  type AuthorizationResult,
  type WorkflowService,
} from "../../src/index.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent, releasesBeforeM14 } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const { catalogs, policies } = releasesBeforeM14();
const LEASE = { ownerId: "test-worker", leaseMs: 30_000 };
const CONTRACTOR = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "CONTRACTOR",
} as const;
/** Policy 1.1.0 for an engineering contractor: 2 ALLOW, 1 DENY, 1 REQUIRES_APPROVAL. */
const MIXED = ["aws-dev", "aws-prod", "cursor-license", "github-org-membership"];

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

function servicesWith(
  fake = new FakeServiceNow(),
  opts: { policies?: PolicyRegistry; catalogs?: CatalogRegistry } = {},
) {
  const extOps = createExternalOperationService(handle.db, {
    servicenow: fake,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 2, delayMs: 1 },
  });
  const authz = createAccessAuthorizationService(handle.db, {
    policies: opts.policies ?? policies,
    catalogs: opts.catalogs ?? catalogs,
    workflows,
    externalOperations: extOps,
  });
  const approvalSvc = createApprovalService(handle.db, { servicenow: fake, workflows });
  return { fake, extOps, authz, approvalSvc };
}

/** A hire through HRIS intake, moved to ACCESS_PLANNING, with a completed M6A agent run. */
async function agentRunFor(
  resourceIds: string[],
  facts: Partial<Pick<HrisOfferSignedEvent, keyof typeof CONTRACTOR>> = CONTRACTOR,
  registry: CatalogRegistry = catalogs,
) {
  const event = newOfferSignedEvent({
    ...CONTRACTOR,
    ...facts,
    jobDescription: "Builds services.",
  });
  const { workflowId } = await createHrisIntakeService(handle.db).acceptOfferSigned(event);
  const wf = (await workflows.getWorkflow(workflowId))!.workflow;
  await workflows.transition({
    workflowId,
    to: "ACCESS_PLANNING",
    expectedVersion: wf.version,
    actor: "test",
  });
  const provider = createScriptedModelProvider([outputOf(...resourceIds)]);
  const agent = createRoleAccessAgent({ provider, sleep: async () => {} });
  const recommender = createRoleAccessRecommendationService(handle.db, {
    agent,
    catalogs: registry,
  });
  const result = await recommender.recommendAccess({ workflowId });
  return { event, workflowId, agentRunId: result.agentRunId, provider };
}

const byResource = (r: AuthorizationResult) =>
  Object.fromEntries(r.resources.map((x) => [x.resourceId, x]));
const decisionsFor = (agentRunId: string) =>
  handle.db.select().from(accessDecisions).where(eq(accessDecisions.agentRunId, agentRunId));
const requestsFor = (agentRunId: string) =>
  handle.db.select().from(accessRequests).where(eq(accessRequests.agentRunId, agentRunId));
const opsFor = (workflowId: string) =>
  handle.db.select().from(externalOperations).where(eq(externalOperations.workflowId, workflowId));
const stateOf = async (workflowId: string) =>
  (await workflows.getWorkflow(workflowId))!.workflow.state;

async function authzError(promise: Promise<unknown>): Promise<AuthorizationError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AuthorizationError) return err;
    throw err;
  }
  throw new Error("expected an AuthorizationError");
}

/** Executes the M4B operation (as the worker would) and returns its ticket. */
async function executeTicket(s: ReturnType<typeof servicesWith>, opId: string) {
  const done = await s.extOps.execute(opId, LEASE);
  return { sysId: done.externalId, number: done.externalReference, via: done.via };
}

async function deliverCallback(s: ReturnType<typeof servicesWith>, opId: string, suffix: string) {
  const [op] = await handle.db
    .select()
    .from(externalOperations)
    .where(eq(externalOperations.id, opId));
  const { callbackEventId } = await s.approvalSvc.recordServiceNowCallback({
    eventId: `${op!.externalId}:${suffix}`,
    instance: "dev000001",
    table: "x_0000000_autonomo_onboarding_access_request",
    sysId: op!.externalId!,
    number: op!.externalReference!,
    correlationKey: op!.correlationKey,
  });
  return s.approvalSvc.processCallback(callbackEventId);
}

describe("authorization outcomes", () => {
  it("persists one independent decision per resource for a mixed ALLOW/DENY/approval run", async () => {
    const { workflowId, agentRunId, event } = await agentRunFor(MIXED);
    const s = servicesWith();
    const result = await s.authz.authorizeAgentRun({ agentRunId });

    expect(result).toMatchObject({
      agentRunId,
      workflowId,
      employeeId: event.employeeId,
      policyVersion: policies.current.policyVersion,
      policyHash: policies.current.policyHash,
      catalogVersion: "1.0.0",
      catalogHash: catalogs.current.catalogHash,
      facts: { ...CONTRACTOR, employeeFactsSourceEventId: event.eventId },
      complete: true,
      replayed: false,
      failures: [],
      summary: { total: 4, allowed: 2, denied: 1, requiresApproval: 1, failed: 0 },
      workflowState: "AWAITING_APPROVAL",
    });
    const r = byResource(result);
    expect(r["github-org-membership"]).toMatchObject({
      decision: "ALLOW",
      matchedRuleId: "engineering-baseline",
      reasonCode: "ENGINEERING_BASELINE",
      status: "READY_FOR_PROVISIONING",
      externalOperationId: null,
    });
    expect(r["aws-dev"]).toMatchObject({ decision: "ALLOW", status: "READY_FOR_PROVISIONING" });
    expect(r["aws-prod"]).toMatchObject({
      decision: "DENY",
      matchedRuleId: "non-employee-production-deny",
      reasonCode: "NON_EMPLOYEE_PRODUCTION_ACCESS_DENIED",
      status: "DENIED",
      externalOperationId: null,
    });
    expect(r["cursor-license"]).toMatchObject({
      decision: "REQUIRES_APPROVAL",
      matchedRuleId: "contractor-license-approval",
      reasonCode: "CONTRACTOR_LICENSE_REQUIRES_APPROVAL",
      status: "AWAITING_APPROVAL",
    });
    expect(r["cursor-license"]!.externalOperationId).toBeTruthy();

    // Every decision records its full input snapshot.
    const rows = await decisionsFor(agentRunId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        workflowId,
        catalogVersion: "1.0.0",
        catalogHash: catalogs.current.catalogHash,
        policyVersion: "1.1.0",
        policyHash: policies.current.policyHash,
        ...CONTRACTOR,
        employeeFactsSourceEventId: event.eventId,
      });
      expect(row.logicalDecisionKey).toMatch(/^access-decision:[0-9a-f]{64}$/);
    }
    // Only the approval-required resource has a ServiceNow operation, tied to its decision.
    const ops = await opsFor(workflowId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.idempotencyKey).toContain(`decision=${r["cursor-license"]!.accessDecisionId}`);
    expect(ops[0]!.request).toMatchObject({
      resourceId: "cursor-license",
      policyDecision: "requires_approval",
      approvalState: "pending",
    });
  });

  it("moves an all-ALLOW/DENY run straight to PROVISIONING without any ticket", async () => {
    const { workflowId, agentRunId } = await agentRunFor(["aws-prod", "github-org-membership"]);
    const result = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(result.summary).toMatchObject({ allowed: 1, denied: 1, requiresApproval: 0 });
    expect(result.workflowState).toBe("PROVISIONING");
    expect(await opsFor(workflowId)).toHaveLength(0);
  });

  it("evaluates only recommended resources; dependencies stay metadata", async () => {
    const { agentRunId } = await agentRunFor(["github-team-frontend"]);
    const result = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(result.resources.map((x) => x.resourceId)).toEqual(["github-team-frontend"]);
    expect(result.resources[0]!.dependsOn).toEqual(["github-org-membership"]);
    expect((await decisionsFor(agentRunId)).map((d) => d.resourceId)).toEqual([
      "github-team-frontend",
    ]);
  });

  it("authorizes an empty recommendation set with no decisions", async () => {
    const { agentRunId, workflowId } = await agentRunFor([]);
    const result = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(result).toMatchObject({
      complete: true,
      summary: { total: 0 },
      workflowState: "PROVISIONING",
    });
    expect(await decisionsFor(agentRunId)).toHaveLength(0);
    expect(await stateOf(workflowId)).toBe("PROVISIONING");
  });

  it("makes no model call", async () => {
    const { agentRunId, provider } = await agentRunFor(MIXED);
    const before = provider.calls.length;
    await servicesWith().authz.authorizeAgentRun({ agentRunId });
    await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(provider.calls.length).toBe(before);
  });

  it("writes structured audit events without job text", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    await servicesWith().authz.authorizeAgentRun({ agentRunId });
    await servicesWith().authz.authorizeAgentRun({ agentRunId });
    const events = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workflowId, workflowId), like(auditEvents.eventType, "access.%")));
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual([
      "access.allowed",
      "access.allowed",
      "access.approval_required",
      "access.denied",
      "access.policy_evaluated",
      "access.servicenow_requested",
    ]);
    const denied = events.find((e) => e.eventType === "access.denied")!;
    expect(denied.payload).toMatchObject({
      agentRunId,
      resourceId: "aws-prod",
      decision: "DENY",
      matchedRuleId: "non-employee-production-deny",
      reasonCode: "NON_EMPLOYEE_PRODUCTION_ACCESS_DENIED",
      policyVersion: "1.1.0",
      catalogVersion: "1.0.0",
    });
    expect(JSON.stringify(events)).not.toContain("Builds services");
  });
});

describe("snapshot and version guarantees", () => {
  it("FACT DRIFT: uses the agent run's snapshot A even after HRIS changes the employee to B", async () => {
    const { event, workflowId, agentRunId } = await agentRunFor(["aws-prod", "cursor-license"]);
    // Facts B: the same employee becomes FULL_TIME through a later HRIS event.
    const update = {
      ...newOfferSignedEvent({ ...CONTRACTOR, employmentType: "FULL_TIME" }),
      employeeId: event.employeeId,
      employee: event.employee,
    };
    await createHrisIntakeService(handle.db).acceptOfferSigned(update);
    const [current] = await handle.db
      .execute<{ employment_type: string }>(
        sql`SELECT employment_type FROM employees WHERE hris_employee_id = ${event.employeeId}`,
      )
      .then((r) => r.rows);
    expect(current!.employment_type).toBe("FULL_TIME");

    const result = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    // Snapshot A (CONTRACTOR): aws-prod DENY, cursor-license REQUIRES_APPROVAL.
    // Facts B (FULL_TIME) would have given REQUIRES_APPROVAL and ALLOW.
    const r = byResource(result);
    expect([r["aws-prod"]!.decision, r["cursor-license"]!.decision]).toEqual([
      "DENY",
      "REQUIRES_APPROVAL",
    ]);
    expect(result.facts).toMatchObject({
      employmentType: "CONTRACTOR",
      employeeFactsSourceEventId: event.eventId,
    });
    for (const d of await decisionsFor(agentRunId)) {
      expect([d.employmentType, d.employeeFactsSourceEventId]).toEqual([
        "CONTRACTOR",
        event.eventId,
      ]);
    }
    expect(workflowId).toBe(result.workflowId);
  });

  it("POLICY DRIFT: a newer current policy never re-authorizes an already authorized run", async () => {
    const { agentRunId } = await agentRunFor(["cursor-license", "github-org-membership"]);
    const first = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(first.policyVersion).toBe("1.1.0");

    // Release 1.3.0 (current), which would ALLOW contractor licenses.
    const base = POLICY_RELEASES.find(
      (r) => (r.document as { policyVersion: string }).policyVersion === "1.1.0",
    )!;
    const doc = structuredClone(base.document) as {
      policyVersion: string;
      rules: { ruleId: string }[];
    };
    doc.policyVersion = "1.3.0";
    doc.rules = doc.rules.filter((rule) => rule.ruleId !== "contractor-license-approval");
    const newer = new PolicyRegistry({
      releases: [
        ...POLICY_RELEASES,
        { document: doc, policyHash: new PolicyEngine(doc, catalogs).policyHash },
      ],
      currentVersion: "1.3.0",
      catalogs,
      canonicalFacts: {
        departments: DEPARTMENT_CODES,
        roleFamilies: ROLE_FAMILY_CODES,
        employmentTypes: EMPLOYMENT_TYPE_CODES,
      },
    });
    expect(
      newer.current.evaluate({
        subject: {
          employeeId: "x",
          department: "ENGINEERING",
          roleFamily: "SOFTWARE_ENGINEER",
          employmentType: "CONTRACTOR",
        },
        catalog: catalogs.current.reference,
        resourceId: "cursor-license",
      }).decision,
    ).toBe("ALLOW");

    const replay = await servicesWith(new FakeServiceNow(), {
      policies: newer,
    }).authz.authorizeAgentRun({ agentRunId });
    expect(replay).toMatchObject({
      replayed: true,
      policyVersion: "1.1.0",
      policyHash: first.policyHash,
    });
    expect(byResource(replay)["cursor-license"]!.decision).toBe("REQUIRES_APPROVAL");
    expect(await decisionsFor(agentRunId)).toHaveLength(2);

    // The recorded decision still resolves and replays under 1.1.0 and its hash.
    const [stored] = await handle.db
      .select()
      .from(accessDecisions)
      .where(
        and(
          eq(accessDecisions.agentRunId, agentRunId),
          eq(accessDecisions.resourceId, "cursor-license"),
        ),
      );
    const engine = newer.resolve({
      policyVersion: stored!.policyVersion,
      policyHash: stored!.policyHash,
    });
    expect(engine.policyVersion).toBe("1.1.0");

    const locked = await authzError(
      servicesWith(new FakeServiceNow(), { policies: newer }).authz.authorizeAgentRun({
        agentRunId,
        policyVersion: "1.3.0",
      }),
    );
    expect(locked.code).toBe("POLICY_VERSION_LOCKED");
  });

  it("authorizes with an explicit historical policy version and records it", async () => {
    const { agentRunId } = await agentRunFor(["cursor-license"]);
    const result = await servicesWith().authz.authorizeAgentRun({
      agentRunId,
      policyVersion: "1.0.0",
    });
    expect([result.policyVersion, result.policyHash]).toEqual([
      "1.0.0",
      policies.get("1.0.0").policyHash,
    ]);
    const [row] = await decisionsFor(agentRunId);
    expect([row!.policyVersion, row!.policyHash, row!.matchedRuleId]).toEqual([
      "1.0.0",
      policies.get("1.0.0").policyHash,
      "contractor-license-approval",
    ]);
  });

  it("rejects a policy whose hash no longer matches the recorded decisions", async () => {
    const { agentRunId } = await agentRunFor(["github-org-membership"]);
    const variant = (label: string) => {
      const base = POLICY_RELEASES.find(
        (r) => (r.document as { policyVersion: string }).policyVersion === "1.1.0",
      )!;
      const doc = structuredClone(base.document) as {
        policyVersion: string;
        rules: { explanation: string }[];
      };
      doc.policyVersion = "1.3.0";
      doc.rules[0]!.explanation = `Variant ${label}.`;
      return new PolicyRegistry({
        releases: [
          ...POLICY_RELEASES,
          { document: doc, policyHash: new PolicyEngine(doc, catalogs).policyHash },
        ],
        currentVersion: "1.3.0",
        catalogs,
      });
    };
    await servicesWith(new FakeServiceNow(), { policies: variant("A") }).authz.authorizeAgentRun({
      agentRunId,
    });
    const err = await authzError(
      servicesWith(new FakeServiceNow(), { policies: variant("B") }).authz.authorizeAgentRun({
        agentRunId,
      }),
    );
    expect(err.code).toBe("POLICY_UNAVAILABLE");
  });

  it("rejects catalog mismatches: unreleased run catalog, and a policy bound to another catalog", async () => {
    const { agentRunId } = await agentRunFor(["github-org-membership"]);
    await handle.db
      .update(agentRuns)
      .set({ catalogHash: `sha256:${"a".repeat(64)}` })
      .where(eq(agentRuns.id, agentRunId));
    expect((await authzError(servicesWith().authz.authorizeAgentRun({ agentRunId }))).code).toBe(
      "CATALOG_UNAVAILABLE",
    );

    const baseCatalog = CATALOG_RELEASES[0]!;
    const nextDoc = { ...(baseCatalog.document as object), catalogVersion: "1.1.0" };
    const twoCatalogs = new CatalogRegistry({
      releases: [
        baseCatalog,
        { document: nextDoc, catalogHash: new ResourceCatalog(nextDoc).catalogHash },
      ],
      currentVersion: "1.1.0",
    });
    const run2 = await agentRunFor(["github-org-membership"], CONTRACTOR, twoCatalogs);
    const err = await authzError(
      servicesWith(new FakeServiceNow(), { catalogs: twoCatalogs }).authz.authorizeAgentRun({
        agentRunId: run2.agentRunId,
      }),
    );
    expect(err.code).toBe("POLICY_CATALOG_MISMATCH");
    expect(await decisionsFor(run2.agentRunId)).toHaveLength(0);
  });

  it("keeps decisions append-only in the database", async () => {
    const { agentRunId } = await agentRunFor(["aws-dev"]);
    await servicesWith().authz.authorizeAgentRun({ agentRunId });
    await expect(
      handle.db
        .update(accessDecisions)
        .set({ decision: "DENY" })
        .where(eq(accessDecisions.agentRunId, agentRunId)),
    ).rejects.toThrow();
    await expect(
      handle.db.delete(accessDecisions).where(eq(accessDecisions.agentRunId, agentRunId)),
    ).rejects.toThrow();
  });
});

describe("run-level failures", () => {
  it("rejects missing, failed and incomplete runs, and invalid fact snapshots", async () => {
    const s = servicesWith();
    expect(
      (
        await authzError(
          s.authz.authorizeAgentRun({ agentRunId: "00000000-0000-4000-8000-000000000000" }),
        )
      ).code,
    ).toBe("AGENT_RUN_NOT_FOUND");

    const failed = await agentRunFor(["aws-dev"]);
    await handle.db.execute(
      sql`UPDATE agent_runs SET status = 'FAILED', error_category = 'TIMEOUT', error_retryable = true WHERE id = ${failed.agentRunId}`,
    );
    expect(
      (await authzError(s.authz.authorizeAgentRun({ agentRunId: failed.agentRunId }))).code,
    ).toBe("AGENT_RUN_NOT_SUCCEEDED");

    const missing = await agentRunFor(["aws-dev", "github-org-membership"]);
    await handle.db.execute(
      sql`DELETE FROM agent_recommendations WHERE agent_run_id = ${missing.agentRunId} AND resource_id = 'aws-dev'`,
    );
    expect(
      (await authzError(s.authz.authorizeAgentRun({ agentRunId: missing.agentRunId }))).code,
    ).toBe("RECOMMENDATIONS_MISSING");

    const invalid = await agentRunFor(["aws-dev"]);
    await handle.db
      .update(agentRuns)
      .set({ departmentCode: "SALES" })
      .where(eq(agentRuns.id, invalid.agentRunId));
    expect(
      (await authzError(s.authz.authorizeAgentRun({ agentRunId: invalid.agentRunId }))).code,
    ).toBe("INVALID_FACTS_SNAPSHOT");
    for (const id of [failed.agentRunId, missing.agentRunId, invalid.agentRunId]) {
      expect(await decisionsFor(id)).toHaveLength(0);
    }
  });

  it("refuses a workflow that is no longer active", async () => {
    const { agentRunId, workflowId } = await agentRunFor(["aws-dev"]);
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "FAILED",
      expectedVersion: wf.version,
      actor: "test",
      reason: "withdrawn",
    });
    expect((await authzError(servicesWith().authz.authorizeAgentRun({ agentRunId }))).code).toBe(
      "WORKFLOW_NOT_ACTIVE",
    );
  });
});

describe("idempotency and concurrency", () => {
  it("returns the existing decisions on a repeated orchestration", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    const s = servicesWith();
    const first = await s.authz.authorizeAgentRun({ agentRunId });
    const again = await s.authz.authorizeAgentRun({ agentRunId });
    expect(again.replayed).toBe(true);
    expect(again.resources.map((x) => x.accessDecisionId)).toEqual(
      first.resources.map((x) => x.accessDecisionId),
    );
    expect(await decisionsFor(agentRunId)).toHaveLength(4);
    expect(await requestsFor(agentRunId)).toHaveLength(4);
    expect(await opsFor(workflowId)).toHaveLength(1);
  });

  it("produces no duplicates under concurrent orchestration of the same run", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => servicesWith().authz.authorizeAgentRun({ agentRunId })),
    );
    for (const r of results) expect(r.complete).toBe(true);
    expect(await decisionsFor(agentRunId)).toHaveLength(4);
    expect(await requestsFor(agentRunId)).toHaveLength(4);
    expect(await opsFor(workflowId)).toHaveLength(1);
    expect(await stateOf(workflowId)).toBe("AWAITING_APPROVAL");
    const transitions = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "workflow.transitioned"),
        ),
      );
    expect(transitions.map((t) => t.toState).sort()).toEqual([
      "ACCESS_PLANNING",
      "AWAITING_APPROVAL",
      "POLICY_REVIEW",
    ]);
  });

  it("keeps resources independent: one failing resource never blocks or corrupts the others", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    await handle.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_id = 'aws-dev' AND NEW.agent_run_id = '${agentRunId}' THEN
          RAISE EXCEPTION 'simulated failure';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_fail_decision ON access_decisions;
      CREATE TRIGGER test_fail_decision BEFORE INSERT ON access_decisions
        FOR EACH ROW EXECUTE FUNCTION test_fail_decision();
    `),
    );
    let partial: AuthorizationResult;
    try {
      partial = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS test_fail_decision ON access_decisions`);
    }
    expect(partial.complete).toBe(false);
    expect(partial.failures).toMatchObject([
      { resourceId: "aws-dev", code: "PERSISTENCE", retryable: true },
    ]);
    expect(partial.summary).toMatchObject({
      allowed: 1,
      denied: 1,
      requiresApproval: 1,
      failed: 1,
    });
    // The failed resource's transaction rolled back; the others committed; the phase stays open.
    expect((await decisionsFor(agentRunId)).map((d) => d.resourceId).sort()).toEqual([
      "aws-prod",
      "cursor-license",
      "github-org-membership",
    ]);
    expect(await stateOf(workflowId)).toBe("POLICY_REVIEW");

    const retry = await servicesWith().authz.authorizeAgentRun({ agentRunId });
    expect(retry).toMatchObject({ complete: true, workflowState: "AWAITING_APPROVAL" });
    expect(await decisionsFor(agentRunId)).toHaveLength(4);
    expect(await opsFor(workflowId)).toHaveLength(1);
  });
});

describe("ServiceNow approval routing", () => {
  it("creates exactly one ticket, even across repeated orchestration and executions", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    const s = servicesWith();
    const result = await s.authz.authorizeAgentRun({ agentRunId });
    const opId = byResource(result)["cursor-license"]!.externalOperationId!;
    await executeTicket(s, opId);
    await s.authz.authorizeAgentRun({ agentRunId });
    expect((await executeTicket(s, opId)).via).toBe("already_succeeded");
    expect(s.fake.records).toHaveLength(1);
    expect(s.fake.posts).toBe(1);
    const again = await s.authz.authorizeAgentRun({ agentRunId });
    expect(byResource(again)["cursor-license"]).toMatchObject({
      externalOperationStatus: "SUCCEEDED",
      ticketNumber: s.fake.records[0]!.number,
    });
    expect(await opsFor(workflowId)).toHaveLength(1);
  });

  it("reconciles an uncertain outcome and survives a temporary outage without a duplicate ticket", async () => {
    const lost = await agentRunFor(MIXED);
    const s = servicesWith();
    s.fake.createBehaviors.push("lost-after-create");
    const opId = byResource(await s.authz.authorizeAgentRun({ agentRunId: lost.agentRunId }))[
      "cursor-license"
    ]!.externalOperationId!;
    const outcome = await executeTicket(s, opId);
    expect(outcome.via).toBe("reconciled_after_unknown");
    expect(s.fake.records).toHaveLength(1);

    const down = await agentRunFor(MIXED);
    const s2 = servicesWith();
    s2.fake.createBehaviors.push("503-before-create");
    const opId2 = byResource(await s2.authz.authorizeAgentRun({ agentRunId: down.agentRunId }))[
      "cursor-license"
    ]!.externalOperationId!;
    await expect(s2.extOps.execute(opId2, LEASE)).rejects.toThrow();
    const [request] = await handle.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.externalOperationId, opId2));
    expect(request!.status).toBe("AWAITING_APPROVAL");
    await handle.db.execute(
      sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${opId2} AND owner_token IS NOT NULL`,
    );
    await executeTicket(s2, opId2);
    expect(s2.fake.records).toHaveLength(1);
  });

  it("an approved resource becomes READY_FOR_PROVISIONING; others stay unchanged; replay is harmless", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    const s = servicesWith();
    const result = await s.authz.authorizeAgentRun({ agentRunId });
    const opId = byResource(result)["cursor-license"]!.externalOperationId!;
    const ticket = await executeTicket(s, opId);
    const before = await requestsFor(agentRunId);

    s.fake.setApprovalState(ticket.sysId, "approved");
    const processed = await deliverCallback(s, opId, "5");
    expect(processed).toMatchObject({ outcome: "APPLIED_APPROVED", workflowResumed: true });
    expect(await deliverCallback(s, opId, "5")).toMatchObject({ alreadyProcessed: true });
    expect(await deliverCallback(s, opId, "6")).toMatchObject({ outcome: "ALREADY_APPLIED" });

    const after = await requestsFor(agentRunId);
    const approvedRow = after.find((x) => x.resourceId === "cursor-license")!;
    const [approval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.externalOperationId, opId));
    expect(approvedRow).toMatchObject({
      status: "READY_FOR_PROVISIONING",
      authorizedVia: "APPROVAL",
      approvalId: approval!.id,
      version: 3,
    });
    for (const other of after.filter((x) => x.resourceId !== "cursor-license")) {
      const was = before.find((x) => x.id === other.id)!;
      expect([other.status, other.version]).toEqual([was.status, was.version]);
    }
    expect(await stateOf(workflowId)).toBe("PROVISIONING");
    const verified = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "access.approval_verified"),
        ),
      );
    expect(verified).toHaveLength(1);
    const resumes = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "workflow.transitioned"),
          eq(auditEvents.toState, "PROVISIONING"),
        ),
      );
    expect(resumes).toHaveLength(1);
  });

  it("a rejected resource becomes REJECTED (terminal for that resource); others are unaffected", async () => {
    const { workflowId, agentRunId } = await agentRunFor(MIXED);
    const s = servicesWith();
    const result = await s.authz.authorizeAgentRun({ agentRunId });
    const opId = byResource(result)["cursor-license"]!.externalOperationId!;
    const ticket = await executeTicket(s, opId);
    s.fake.setApprovalState(ticket.sysId, "rejected");
    expect(await deliverCallback(s, opId, "5")).toMatchObject({ outcome: "APPLIED_REJECTED" });

    const rows = Object.fromEntries((await requestsFor(agentRunId)).map((x) => [x.resourceId, x]));
    expect(rows["cursor-license"]).toMatchObject({ status: "REJECTED", authorizedVia: null });
    expect(rows["github-org-membership"]!.status).toBe("READY_FOR_PROVISIONING");
    expect(rows["aws-dev"]!.status).toBe("READY_FOR_PROVISIONING");
    expect(rows["aws-prod"]!.status).toBe("DENIED");
    // The decision itself is untouched; replaying authorization does not reopen the resource.
    const replay = await s.authz.authorizeAgentRun({ agentRunId });
    expect(byResource(replay)["cursor-license"]).toMatchObject({
      decision: "REQUIRES_APPROVAL",
      status: "REJECTED",
    });
    expect(await stateOf(workflowId)).toBe("PROVISIONING");
    const rejected = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowId, workflowId),
          eq(auditEvents.eventType, "access.approval_rejected"),
        ),
      );
    expect(rejected).toHaveLength(1);
  });
});
