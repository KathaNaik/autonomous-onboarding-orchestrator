import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry, type CatalogRegistry } from "@aoo/catalog";
import { accessDecisions, accessRequests, createDatabase, type DatabaseHandle } from "@aoo/db";
import type { OktaGroupTarget } from "@aoo/okta";
import { loadPolicyRegistry, type PolicyRegistry } from "@aoo/policy";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createAccessAuthorizationService,
  createApprovalService,
  createExternalOperationService,
  createHrisIntakeService,
  createOktaHandlers,
  createOktaProvisioningService,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createServiceNowFulfillmentHandler,
  createServiceNowFulfillmentService,
  createWorkflowService,
  type WorkflowService,
} from "../../src/index.js";
import { FakeOkta } from "./fake-okta.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent, releasesBeforeM14 } from "./helpers.js";

/**
 * (M14) Catalog 1.1.0 / policy 1.2.0: Slack and AWS development are Okta groups, so an engineer's
 * everyday tools are set up with no person involved. Workflows bound to catalog 1.0.0 keep its
 * ServiceNow fulfillment (the plan's exact catalog is always used).
 */
let handle: DatabaseHandle;
let workflows: WorkflowService;
const current = { catalogs: loadCatalogRegistry(), policies: loadPolicyRegistry() };
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
const GROUPS = {
  "okta-engineering-group": "AOO Engineering (test)",
  "slack-engineering": "AOO Slack Engineering (test)",
  "aws-dev": "AOO AWS Development (test)",
  "jira-engineering": "AOO Jira Engineering (test)",
} as const;

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

function world() {
  const okta = new FakeOkta();
  const sn = new FakeServiceNow();
  const targets = new Map<string, OktaGroupTarget>(
    Object.entries(GROUPS).map(([resourceId, name]) => [
      resourceId,
      { resourceId, groupId: okta.seedGroup(name), expectedName: name },
    ]),
  );
  return { okta, sn, targets };
}
type World = ReturnType<typeof world>;

function services(w: World, r: { catalogs: CatalogRegistry; policies: PolicyRegistry }) {
  const extOps = createExternalOperationService(handle.db, {
    servicenow: w.sn,
    handlers: [...createOktaHandlers(w.okta), createServiceNowFulfillmentHandler(w.sn)],
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const owner = { ownerId: "m14", leaseMs: 30_000, busyWaitMs: 5_000 };
  const coordinator = createProvisioningCoordinator(handle.db, {
    catalogs: r.catalogs,
    workflows,
    okta: createOktaProvisioningService(handle.db, {
      catalogs: r.catalogs,
      externalOperations: extOps,
      okta: w.okta,
      targets: w.targets,
      ...owner,
    }),
    servicenow: createServiceNowFulfillmentService(handle.db, {
      catalogs: r.catalogs,
      externalOperations: extOps,
      servicenow: w.sn,
      ...owner,
    }),
    reconcileIntervalMs: 600_000,
    fulfillmentReconcileIntervalMs: 120_000,
    retryDelayMs: 600_000,
  });
  const authz = createAccessAuthorizationService(handle.db, {
    policies: r.policies,
    catalogs: r.catalogs,
    workflows,
    externalOperations: extOps,
  });
  const approvals = createApprovalService(handle.db, { servicenow: w.sn, workflows });
  return { extOps, coordinator, authz, approvals };
}

async function authorized(
  w: World,
  resourceIds: string[],
  r: { catalogs: CatalogRegistry; policies: PolicyRegistry },
) {
  const event = newOfferSignedEvent({ ...ENGINEER, jobDescription: "Synthetic." });
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
    catalogs: r.catalogs,
  }).recommendAccess({ workflowId });
  const result = await services(w, r).authz.authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((x) => [x.resourceId, x.accessRequestId]));
  const ops = Object.fromEntries(
    result.resources.map((x) => [x.resourceId, x.externalOperationId]),
  );
  return { workflowId, agentRunId, ids, ops, result };
}

const statusOf = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!.status;
const stateOf = async (id: string) => (await workflows.getWorkflow(id))!.workflow.state;

describe("catalog 1.1.0: everyday engineering tools are automatic", () => {
  it("Slack, AWS development and the engineering group: one Okta user, three groups, no ServiceNow", async () => {
    const w = world();
    const resources = ["aws-dev", "okta-engineering-group", "slack-engineering"];
    const a = await authorized(w, resources, current);
    expect(a.result).toMatchObject({
      catalogVersion: "1.1.0",
      policyVersion: "1.2.0",
      summary: { allowed: 3, requiresApproval: 0 },
      workflowState: "PROVISIONING",
    });
    await services(w, current).coordinator.coordinateProvisioning({ workflowId: a.workflowId });
    for (const id of resources) expect(await statusOf(a.ids[id]!)).toBe("PROVISIONED");
    expect(await stateOf(a.workflowId)).toBe("ONBOARDING_GENERATION");
    expect(w.okta.users).toHaveLength(1);
    expect(w.okta.memberships.size).toBe(3);
    expect([w.sn.posts, w.sn.records.length]).toEqual([0, 0]);
    const decisions = await handle.db
      .select()
      .from(accessDecisions)
      .where(eq(accessDecisions.agentRunId, a.agentRunId));
    expect(new Set(decisions.map((d) => `${d.catalogVersion}/${d.policyVersion}`))).toEqual(
      new Set(["1.1.0/1.2.0"]),
    );
  });

  it("AWS production still needs an approver; after approval it waits on the Okta-granted AWS development, then IT fulfills it", async () => {
    const w = world();
    const a = await authorized(w, ["aws-dev", "aws-prod"], current);
    expect(a.result.workflowState).toBe("AWAITING_APPROVAL");
    const s = services(w, current);
    const ticket = await s.extOps.execute(a.ops["aws-prod"]!, { ownerId: "t", leaseMs: 30_000 });
    w.sn.setApprovalState(ticket.externalId, "approved");
    const { callbackEventId } = await s.approvals.recordServiceNowCallback({
      eventId: `${ticket.externalId}:1`,
      instance: "dev000001",
      table: "x_0000000_autonomo_onboarding_access_request",
      sysId: ticket.externalId,
      number: ticket.externalReference,
      correlationKey: w.sn.records[0]!.correlationKey,
    });
    await s.approvals.processCallback(callbackEventId);
    await s.coordinator.coordinateProvisioning({ workflowId: a.workflowId });
    expect(await statusOf(a.ids["aws-dev"]!)).toBe("PROVISIONED");
    expect(w.okta.memberships.size).toBe(1);
    // aws-prod: one approval record, then one fulfillment record (only after aws-dev is ready).
    expect(w.sn.records.map((r) => r.requestKind ?? "approval").sort()).toEqual([
      "approval",
      "fulfillment",
    ]);
    expect(await statusOf(a.ids["aws-prod"]!)).toBe("PROVISIONING");
  });

  it("a workflow authorized under catalog 1.0.0 keeps ServiceNow fulfillment for Slack", async () => {
    const w = world();
    const a = await authorized(w, ["slack-engineering"], releasesBeforeM14());
    expect(a.result.catalogVersion).toBe("1.0.0");
    // Coordinated by a worker that already has catalog 1.1.0 as current.
    await services(w, current).coordinator.coordinateProvisioning({ workflowId: a.workflowId });
    expect(w.sn.records.map((r) => [r.resourceId, r.requestKind])).toEqual([
      ["slack-engineering", "fulfillment"],
    ]);
    expect(w.okta.memberships.size).toBe(0);
  });
});
