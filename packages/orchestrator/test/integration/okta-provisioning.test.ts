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
  employees,
  externalIdentities,
  externalOperations,
  type DatabaseHandle,
} from "@aoo/db";
import type { OktaGroupTarget } from "@aoo/okta";
import { POLICY_RELEASES, PolicyEngine, PolicyRegistry, loadPolicyRegistry } from "@aoo/policy";
import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  ROLE_FAMILY_CODES,
  type HrisOfferSignedEvent,
} from "@aoo/shared";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  OktaProvisioningError,
  createAccessAuthorizationService,
  createApprovalService,
  createExternalOperationService,
  createHrisIntakeService,
  createOktaHandlers,
  createOktaProvisioningService,
  createRoleAccessRecommendationService,
  createWorkflowService,
  type WorkflowService,
} from "../../src/index.js";
import { FakeOkta } from "./fake-okta.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent } from "./helpers.js";

let handle: DatabaseHandle;
let workflows: WorkflowService;
const defaultCatalogs = loadCatalogRegistry();
const defaultPolicies = loadPolicyRegistry(defaultCatalogs);
const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
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

interface Setup {
  okta: FakeOkta;
  engGroup: string;
  jiraGroup: string;
  catalogs?: CatalogRegistry;
  policies?: PolicyRegistry;
}

function oktaWorld(): Setup {
  const okta = new FakeOkta();
  return {
    okta,
    engGroup: okta.seedGroup("AOO Engineering (test)"),
    jiraGroup: okta.seedGroup("Jira Engineering Users"),
  };
}

function provisioner(
  world: Setup,
  opts: { targets?: Map<string, OktaGroupTarget>; leaseMs?: number; ownerId?: string } = {},
) {
  const targets =
    opts.targets ??
    new Map<string, OktaGroupTarget>([
      [
        "okta-engineering-group",
        {
          resourceId: "okta-engineering-group",
          groupId: world.engGroup,
          expectedName: "AOO Engineering (test)",
        },
      ],
      [
        "jira-engineering",
        { resourceId: "jira-engineering", groupId: world.jiraGroup, expectedName: null },
      ],
    ]);
  const extOps = createExternalOperationService(handle.db, {
    handlers: createOktaHandlers(world.okta),
    reconcile: { attempts: 2, delayMs: 1 },
  });
  const service = createOktaProvisioningService(handle.db, {
    catalogs: world.catalogs ?? defaultCatalogs,
    externalOperations: extOps,
    okta: world.okta,
    targets,
    leaseMs: opts.leaseMs ?? 30_000,
    ownerId: opts.ownerId ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    busyWaitMs: 5_000,
  });
  return { service, extOps };
}

/** A hire authorized through the real M5C→M6A→M6B chain; returns access request ids by resource. */
async function authorized(
  resourceIds: string[],
  facts: Partial<Pick<HrisOfferSignedEvent, keyof typeof ENGINEER>> = ENGINEER,
  world?: Setup,
) {
  const catalogs = world?.catalogs ?? defaultCatalogs;
  const policies = world?.policies ?? defaultPolicies;
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
  const fake = new FakeServiceNow();
  const snOps = createExternalOperationService(handle.db, {
    servicenow: fake,
    correlationPrefix: "aoo-test-oar-",
    reconcile: { attempts: 1, delayMs: 1 },
  });
  const result = await createAccessAuthorizationService(handle.db, {
    policies,
    catalogs,
    workflows,
    externalOperations: snOps,
  }).authorizeAgentRun({ agentRunId });
  const ids = Object.fromEntries(result.resources.map((r) => [r.resourceId, r.accessRequestId]));
  const [employee] = await handle.db
    .select()
    .from(employees)
    .where(eq(employees.hrisEmployeeId, event.employeeId));
  return { ids, workflowId, event, employee: employee!, result, fake, snOps };
}

const requestRow = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;
const oktaOps = (type: string, workflowId?: string) =>
  handle.db
    .select()
    .from(externalOperations)
    .where(
      and(
        eq(externalOperations.operationType, type),
        ...(workflowId ? [eq(externalOperations.workflowId, workflowId)] : []),
      ),
    );
const linksFor = (employeeId: string) =>
  handle.db.select().from(externalIdentities).where(eq(externalIdentities.employeeId, employeeId));
const auditFor = (workflowId: string, prefix: string) =>
  handle.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workflowId, workflowId), like(auditEvents.eventType, `${prefix}%`)));

async function provisionError(p: Promise<unknown>): Promise<OktaProvisioningError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OktaProvisioningError) return err;
    throw err;
  }
  throw new Error("expected OktaProvisioningError");
}

describe("provisioning an authorized Okta resource", () => {
  it("creates the identity, links it, adds the membership and persists PROVISIONED with evidence", async () => {
    const world = oktaWorld();
    const { ids, workflowId, employee } = await authorized([
      "okta-engineering-group",
      "github-org-membership",
    ]);
    const result = await provisioner(world).service.provisionOktaAccess({
      accessRequestId: ids["okta-engineering-group"]!,
    });

    expect(result).toMatchObject({
      status: "PROVISIONED",
      replayed: false,
      identity: "CREATED",
      membership: "ADDED",
      oktaGroupId: world.engGroup,
    });
    expect(world.okta.creates).toBe(1);
    expect(world.okta.users).toHaveLength(1);
    const user = world.okta.users[0]!;
    expect(user.profile).toMatchObject({
      login: employee.email,
      email: employee.email,
      employeeNumber: employee.hrisEmployeeId,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });
    expect(world.okta.memberships.has(`${world.engGroup}:${user.id}`)).toBe(true);

    const row = await requestRow(ids["okta-engineering-group"]!);
    expect(row).toMatchObject({
      status: "PROVISIONED",
      authorizedVia: "POLICY",
      providerSubjectId: user.id,
      providerTargetId: world.engGroup,
      provisioningOperationId: result.membershipOperationId,
      provisioningErrorCode: null,
    });
    expect(row.provisionedAt).not.toBeNull();
    const links = await linksFor(employee.id);
    expect(links).toMatchObject([
      { provider: "okta", providerSubjectId: user.id, providerLogin: employee.email },
    ]);
    const [ensure] = await oktaOps("okta.ensure_user", workflowId);
    const [membership] = await oktaOps("okta.add_group_membership", workflowId);
    expect(ensure).toMatchObject({ status: "SUCCEEDED", externalId: user.id, provider: "okta" });
    expect(membership).toMatchObject({
      status: "SUCCEEDED",
      externalReference: world.engGroup,
      id: result.membershipOperationId,
    });
    expect(membership!.idempotencyKey).toContain(`request=${ids["okta-engineering-group"]}`);

    const types = (await auditFor(workflowId, "")).map((e) => e.eventType);
    for (const t of [
      "resource.provisioning_started",
      "okta.identity_created",
      "okta.group_membership_provisioned",
      "resource.provisioned",
    ]) {
      expect(types).toContain(t);
    }
    const provisioned = (await auditFor(workflowId, "resource.provisioned"))[0]!;
    expect(provisioned.payload).toMatchObject({
      provider: "OKTA",
      oktaUserId: user.id,
      oktaGroupId: world.engGroup,
      externalOperationId: result.membershipOperationId,
    });
    expect(JSON.stringify(await auditFor(workflowId, ""))).not.toContain(employee.firstName);
    // The workflow is not completed by M7A.
    expect((await workflows.getWorkflow(workflowId))!.workflow.state).toBe("PROVISIONING");
  });

  it("reuses an existing matching Okta user and an existing membership without writes", async () => {
    const world = oktaWorld();
    const { ids, employee } = await authorized(["okta-engineering-group"]);
    const existing = world.okta.seedUser({
      login: employee.email,
      employeeNumber: employee.hrisEmployeeId,
    });
    world.okta.memberships.add(`${world.engGroup}:${existing.id}`);
    const result = await provisioner(world).service.provisionOktaAccess({
      accessRequestId: ids["okta-engineering-group"]!,
    });
    expect(result).toMatchObject({
      identity: "RESOLVED",
      membership: "ALREADY_PRESENT",
      oktaUserId: existing.id,
    });
    expect([world.okta.creates, world.okta.adds]).toEqual([0, 0]);
  });

  it("uses the verified link on later resources instead of searching again", async () => {
    const world = oktaWorld();
    const { ids } = await authorized(["okta-engineering-group", "jira-engineering"]);
    const p = provisioner(world).service;
    await p.provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! });
    const second = await p.provisionOktaAccess({ accessRequestId: ids["jira-engineering"]! });
    expect(second).toMatchObject({ identity: "LINKED", membership: "ADDED" });
    expect(world.okta.creates).toBe(1);
  });

  it("replays a PROVISIONED request without any Okta call", async () => {
    const world = oktaWorld();
    const { ids } = await authorized(["okta-engineering-group"]);
    const p = provisioner(world).service;
    const first = await p.provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! });
    const calls = world.okta.totalCalls;
    const again = await p.provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! });
    expect(again).toMatchObject({
      replayed: true,
      oktaUserId: first.oktaUserId,
      membershipOperationId: first.membershipOperationId,
    });
    expect(world.okta.totalCalls).toBe(calls);
  });
});

describe("identity conflicts stop automation", () => {
  it("rejects an ambiguous lookup and marks the resource PROVISIONING_FAILED", async () => {
    const world = oktaWorld();
    const { ids, employee, workflowId } = await authorized(["okta-engineering-group"]);
    world.okta.seedUser({ login: employee.email, employeeNumber: employee.hrisEmployeeId });
    world.okta.seedUser({
      login: "old.account@example.com",
      employeeNumber: employee.hrisEmployeeId,
    });
    const err = await provisionError(
      provisioner(world).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect([err.code, err.reason, err.retryable]).toEqual([
      "PROVISIONING_FAILED",
      "AMBIGUOUS_OKTA_IDENTITY",
      false,
    ]);
    expect(world.okta.creates).toBe(0);
    expect(await requestRow(ids["okta-engineering-group"]!)).toMatchObject({
      status: "PROVISIONING_FAILED",
      provisioningErrorCode: "AMBIGUOUS_OKTA_IDENTITY",
    });
    expect(await linksFor(employee.id)).toHaveLength(0);
    expect((await auditFor(workflowId, "resource.provisioning_failed"))[0]!.payload).toMatchObject({
      reason: "AMBIGUOUS_OKTA_IDENTITY",
    });
    // Terminal: a replay makes no provider call.
    const calls = world.okta.totalCalls;
    expect(
      (
        await provisionError(
          provisioner(world).service.provisionOktaAccess({
            accessRequestId: ids["okta-engineering-group"]!,
          }),
        )
      ).code,
    ).toBe("PROVISIONING_FAILED");
    expect(world.okta.totalCalls).toBe(calls);
  });

  it("rejects an Okta user whose identifying attributes conflict", async () => {
    const world = oktaWorld();
    const { ids, employee } = await authorized(["okta-engineering-group"]);
    world.okta.seedUser({ login: employee.email, employeeNumber: "SOMEONE-ELSE" });
    const err = await provisionError(
      provisioner(world).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect(err.reason).toBe("OKTA_IDENTITY_CONFLICT");
    expect(world.okta.creates).toBe(0);
  });

  it("fails before any Okta call when a required identity attribute is missing", async () => {
    const world = oktaWorld();
    const { ids, employee } = await authorized(["okta-engineering-group"]);
    await handle.db.update(employees).set({ firstName: " " }).where(eq(employees.id, employee.id));
    const err = await provisionError(
      provisioner(world).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect(err.code).toBe("MISSING_IDENTITY_ATTRIBUTE");
    expect(world.okta.totalCalls).toBe(0);
    expect((await requestRow(ids["okta-engineering-group"]!)).status).toBe(
      "READY_FOR_PROVISIONING",
    );
  });
});

describe("group target validation", () => {
  it("fails closed when the configured group is missing or not the expected target", async () => {
    const world = oktaWorld();
    const { ids } = await authorized(["okta-engineering-group", "jira-engineering"]);
    const missing = new Map([
      [
        "okta-engineering-group",
        {
          resourceId: "okta-engineering-group",
          groupId: "00gMISSINGmissing123",
          expectedName: "AOO Engineering (test)",
        },
      ],
    ]);
    const err = await provisionError(
      provisioner(world, { targets: missing }).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect(err.reason).toBe("OKTA_GROUP_NOT_FOUND");
    // jira-engineering expects the catalog name, but the configured group is another one.
    const wrong = new Map([
      [
        "jira-engineering",
        { resourceId: "jira-engineering", groupId: world.engGroup, expectedName: null },
      ],
    ]);
    const err2 = await provisionError(
      provisioner(world, { targets: wrong }).service.provisionOktaAccess({
        accessRequestId: ids["jira-engineering"]!,
      }),
    );
    expect(err2.reason).toBe("OKTA_GROUP_MISMATCH");
    expect(world.okta.adds).toBe(0);
  });

  it("refuses a resource with no configured target, before any Okta call", async () => {
    const world = oktaWorld();
    const { ids } = await authorized(["jira-engineering"]);
    const only = new Map([
      [
        "okta-engineering-group",
        { resourceId: "okta-engineering-group", groupId: world.engGroup, expectedName: null },
      ],
    ]);
    const err = await provisionError(
      provisioner(world, { targets: only }).service.provisionOktaAccess({
        accessRequestId: ids["jira-engineering"]!,
      }),
    );
    expect(err.code).toBe("OKTA_TARGET_NOT_CONFIGURED");
    expect(world.okta.totalCalls).toBe(0);
    expect((await requestRow(ids["jira-engineering"]!)).status).toBe("READY_FOR_PROVISIONING");
  });
});

describe("authorization boundary: the Okta adapter is never invoked", () => {
  it.each([
    ["DENIED", { employmentType: "CONTRACTOR" as const }, "aws-prod", "NOT_ELIGIBLE"],
    ["AWAITING_APPROVAL", {}, "aws-prod", "NOT_ELIGIBLE"],
    ["wrong provider (READY GitHub resource)", {}, "github-org-membership", "PROVIDER_MISMATCH"],
  ])("%s", async (_label, facts, resource, code) => {
    const world = oktaWorld();
    const { ids } = await authorized([resource], facts);
    const err = await provisionError(
      provisioner(world).service.provisionOktaAccess({ accessRequestId: ids[resource]! }),
    );
    expect(err.code).toBe(code);
    expect(world.okta.totalCalls).toBe(0);
  });

  it("REJECTED", async () => {
    const world = oktaWorld();
    const { ids, fake, snOps } = await authorized(["aws-prod"]);
    const row = await requestRow(ids["aws-prod"]!);
    const done = await snOps.execute(row.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
    fake.setApprovalState(done.externalId, "rejected");
    const approvals = createApprovalService(handle.db, { servicenow: fake, workflows });
    const [op] = await handle.db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, row.externalOperationId!));
    const { callbackEventId } = await approvals.recordServiceNowCallback({
      eventId: `${done.externalId}:1`,
      instance: "dev000001",
      table: "x_0000000_autonomo_onboarding_access_request",
      sysId: done.externalId,
      number: done.externalReference,
      correlationKey: op!.correlationKey,
    });
    await approvals.processCallback(callbackEventId);
    expect((await requestRow(ids["aws-prod"]!)).status).toBe("REJECTED");
    expect(
      (
        await provisionError(
          provisioner(world).service.provisionOktaAccess({ accessRequestId: ids["aws-prod"]! }),
        )
      ).code,
    ).toBe("NOT_ELIGIBLE");
    expect(world.okta.totalCalls).toBe(0);
  });

  it("forged READY rows: DENY decision, approval-required without a verified approval, mismatched chain", async () => {
    const world = oktaWorld();
    const denied = await authorized(["aws-prod"], { employmentType: "CONTRACTOR" });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'POLICY' WHERE id = ${denied.ids["aws-prod"]}`,
    );
    const pending = await authorized(["aws-prod"]);
    const pendingRow = await requestRow(pending.ids["aws-prod"]!);
    await pending.snOps.execute(pendingRow.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'READY_FOR_PROVISIONING', authorized_via = 'APPROVAL', approval_id = (SELECT id FROM approvals WHERE external_operation_id = ${pendingRow.externalOperationId}) WHERE id = ${pendingRow.id}`,
    );
    const mismatched = await authorized(["github-org-membership"]);
    await handle.db.execute(
      sql`UPDATE access_requests SET resource_id = 'okta-engineering-group' WHERE id = ${mismatched.ids["github-org-membership"]}`,
    );

    const p = provisioner(world).service;
    for (const id of [
      denied.ids["aws-prod"]!,
      pendingRow.id,
      mismatched.ids["github-org-membership"]!,
    ]) {
      expect((await provisionError(p.provisionOktaAccess({ accessRequestId: id }))).code).toBe(
        "AUTHORIZATION_CHAIN_INVALID",
      );
    }
    expect(world.okta.totalCalls).toBe(0);
  });

  it("catalog/hash mismatch: the decision's catalog can't be resolved exactly", async () => {
    const world = oktaWorld();
    const { ids } = await authorized(["okta-engineering-group"]);
    const base = CATALOG_RELEASES[0]!;
    const altered = structuredClone(base.document) as {
      resources: { resourceId: string; description: string }[];
    };
    altered.resources.find((r) => r.resourceId === "okta-engineering-group")!.description =
      "Altered.";
    const mismatchedCatalogs = new CatalogRegistry({
      releases: [{ document: altered, catalogHash: new ResourceCatalog(altered).catalogHash }],
      currentVersion: "1.0.0",
    });
    const err = await provisionError(
      provisioner({ ...world, catalogs: mismatchedCatalogs }).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect(err.code).toBe("CATALOG_UNAVAILABLE");
    expect(world.okta.totalCalls).toBe(0);
  });
});

describe("dependencies (no graph execution)", () => {
  it("fails closed until declared dependencies are PROVISIONED", async () => {
    // A catalog release where the Okta group depends on GitHub org membership, with a policy bound to it.
    const base = CATALOG_RELEASES[0]!;
    const doc = structuredClone(base.document) as {
      catalogVersion: string;
      resources: { resourceId: string; dependsOn: string[] }[];
    };
    doc.catalogVersion = "1.1.0";
    doc.resources.find((r) => r.resourceId === "okta-engineering-group")!.dependsOn = [
      "github-org-membership",
    ];
    const catalogs = new CatalogRegistry({
      releases: [base, { document: doc, catalogHash: new ResourceCatalog(doc).catalogHash }],
      currentVersion: "1.1.0",
    });
    const pol = POLICY_RELEASES.find(
      (r) => (r.document as { policyVersion: string }).policyVersion === "1.1.0",
    )!;
    const pdoc = structuredClone(pol.document) as {
      policyVersion: string;
      catalog: { catalogVersion: string; catalogHash: string };
    };
    pdoc.policyVersion = "1.2.0";
    pdoc.catalog = catalogs.current.reference;
    const policies = new PolicyRegistry({
      releases: [
        ...POLICY_RELEASES,
        { document: pdoc, policyHash: new PolicyEngine(pdoc, catalogs).policyHash },
      ],
      currentVersion: "1.2.0",
      catalogs,
      canonicalFacts: {
        departments: DEPARTMENT_CODES,
        roleFamilies: ROLE_FAMILY_CODES,
        employmentTypes: EMPLOYMENT_TYPE_CODES,
      },
    });
    const world = { ...oktaWorld(), catalogs, policies };
    const { ids } = await authorized(
      ["okta-engineering-group", "github-org-membership"],
      ENGINEER,
      world,
    );
    const p = provisioner(world).service;
    const err = await provisionError(
      p.provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! }),
    );
    expect(err.code).toBe("DEPENDENCIES_NOT_READY");
    expect(err.message).toContain("github-org-membership");
    expect(world.okta.totalCalls).toBe(0);
    // Once the dependency is PROVISIONED (by a later milestone's adapter), the Okta resource
    // proceeds. Simulate that with a dedicated evidence operation for the dependency.
    const { operation: evidence } = await provisioner(world).extOps.requestOperation({
      workflowId: (await requestRow(ids["github-org-membership"]!)).workflowId,
      provider: "github",
      operationType: "test.dependency_evidence",
      idempotencyKey: `test.dependency_evidence:${ids["github-org-membership"]}`,
      correlationKey: `test-evidence:${ids["github-org-membership"]}`,
      request: {},
      actor: "test",
      enqueueExecution: false,
    });
    await handle.db.execute(
      sql`UPDATE access_requests SET status = 'PROVISIONED', provisioned_at = now(), provider_subject_id = 'gh-user', provider_target_id = 'gh-org', provisioning_operation_id = ${evidence.id} WHERE id = ${ids["github-org-membership"]}`,
    );
    expect((await requestRow(ids["github-org-membership"]!)).status).toBe("PROVISIONED");
    expect(
      (await p.provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! })).status,
    ).toBe("PROVISIONED");
  });
});

describe("uncertain outcomes and transient failures", () => {
  it("reconciles a lost create response without a second POST", async () => {
    const world = oktaWorld();
    world.okta.createBehaviors.push("lost-after-write");
    const { ids } = await authorized(["okta-engineering-group"]);
    const result = await provisioner(world).service.provisionOktaAccess({
      accessRequestId: ids["okta-engineering-group"]!,
    });
    expect(result.identity).toBe("CREATED");
    expect([world.okta.creates, world.okta.users.length]).toEqual([1, 1]);
  });

  it("reconciles a lost membership response", async () => {
    const world = oktaWorld();
    world.okta.addBehaviors.push("lost-after-write");
    const { ids } = await authorized(["okta-engineering-group"]);
    const result = await provisioner(world).service.provisionOktaAccess({
      accessRequestId: ids["okta-engineering-group"]!,
    });
    expect(result).toMatchObject({ status: "PROVISIONED", membership: "ADDED" });
    expect(world.okta.adds).toBe(1);
  });

  it("releases on 429 and 5xx, keeps the request PROVISIONING, and completes on re-invocation", async () => {
    const world = oktaWorld();
    world.okta.addBehaviors.push("429", "503-no-effect");
    const { ids } = await authorized(["okta-engineering-group"]);
    const p = provisioner(world).service;
    const id = ids["okta-engineering-group"]!;
    expect((await provisionError(p.provisionOktaAccess({ accessRequestId: id }))).code).toBe(
      "RETRY_LATER",
    );
    expect((await requestRow(id)).status).toBe("PROVISIONING");
    expect((await provisionError(p.provisionOktaAccess({ accessRequestId: id }))).code).toBe(
      "RETRY_LATER",
    );
    expect((await p.provisionOktaAccess({ accessRequestId: id })).status).toBe("PROVISIONED");
    const [op] = await oktaOps("okta.add_group_membership", (await requestRow(id)).workflowId);
    expect(op!.attempts).toBe(3);
  });

  it("does not retry an authentication failure and stores only sanitized errors", async () => {
    const world = oktaWorld();
    const token = "00SecretOktaToken_ABCDEFGHIJKLMNOPQRSTUVWX";
    world.okta.createUser = async () => {
      world.okta.creates++;
      throw new (await import("@aoo/okta")).OktaError(
        "AUTHENTICATION_FAILED",
        "createUser",
        `HTTP 401 Authorization: SSWS ${token}`,
        { status: 401 },
      );
    };
    const { ids, workflowId } = await authorized(["okta-engineering-group"]);
    const err = await provisionError(
      provisioner(world).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
    );
    expect([err.code, err.reason]).toEqual(["PROVISIONING_FAILED", "AUTHENTICATION_FAILED"]);
    expect(world.okta.creates).toBe(1);
    const [op] = await oktaOps("okta.ensure_user", workflowId);
    expect(op!.status).toBe("FAILED");
    expect(JSON.stringify(op)).not.toContain(token);
    expect(op!.lastError).toContain("[REDACTED]");
  });
});

describe("concurrency and crash recovery", () => {
  it.each([2, 6])(
    "%i concurrent provisions of one request → one identity, one operation, one transition",
    async (n) => {
      const world = oktaWorld();
      const { ids, employee, workflowId } = await authorized(["okta-engineering-group"]);
      const p = () => provisioner(world).service;
      const results = await Promise.allSettled(
        Array.from({ length: n }, () =>
          p().provisionOktaAccess({ accessRequestId: ids["okta-engineering-group"]! }),
        ),
      );
      for (const r of results) expect(r.status).toBe("fulfilled");
      expect([world.okta.creates, world.okta.users.length, world.okta.memberships.size]).toEqual([
        1, 1, 1,
      ]);
      expect(await linksFor(employee.id)).toHaveLength(1);
      expect(await oktaOps("okta.add_group_membership", workflowId)).toHaveLength(1);
      expect(await auditFor(workflowId, "resource.provisioned")).toHaveLength(1);
    },
  );

  it("two Okta resources for one new employee create exactly one Okta user", async () => {
    const world = oktaWorld();
    const { ids, employee, workflowId } = await authorized([
      "okta-engineering-group",
      "jira-engineering",
    ]);
    const [a, b] = await Promise.all([
      provisioner(world).service.provisionOktaAccess({
        accessRequestId: ids["okta-engineering-group"]!,
      }),
      provisioner(world).service.provisionOktaAccess({ accessRequestId: ids["jira-engineering"]! }),
    ]);
    expect(a.oktaUserId).toBe(b.oktaUserId);
    expect([world.okta.creates, world.okta.users.length]).toEqual([1, 1]);
    expect(await linksFor(employee.id)).toHaveLength(1);
    expect(await oktaOps("okta.ensure_user", workflowId)).toHaveLength(1);
    expect(await oktaOps("okta.add_group_membership", workflowId)).toHaveLength(2);
  });

  it("crash after the Okta user may have been created: the next owner reconciles, never re-POSTs", async () => {
    const world = oktaWorld();
    let resume!: () => void;
    world.okta.createBehaviors.push({ writeThenHold: new Promise<void>((r) => (resume = r)) });
    const { ids, workflowId } = await authorized(["okta-engineering-group"]);
    const crashed = provisioner(world, { ownerId: "crashed" }).service.provisionOktaAccess({
      accessRequestId: ids["okta-engineering-group"]!,
    });
    const crashedOutcome = crashed.then(
      (r) => (r.replayed ? "converged-without-writes" : "wrote"),
      (e: OktaProvisioningError) => e.code,
    );
    await new Promise((r) => setTimeout(r, 150));
    await handle.db.execute(
      sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE workflow_id = ${workflowId} AND operation_type = 'okta.ensure_user'`,
    );
    const recovered = await provisioner(world, { ownerId: "recovery" }).service.provisionOktaAccess(
      { accessRequestId: ids["okta-engineering-group"]! },
    );
    expect(recovered).toMatchObject({ status: "PROVISIONED", identity: "CREATED" });
    resume();
    // The stale owner is fenced out: its late success write is refused, it re-reads the operation,
    // finds the same verified outcome, and returns it without writing anything.
    expect(await crashedOutcome).toBe("converged-without-writes");
    expect([world.okta.creates, world.okta.users.length]).toEqual([1, 1]);
    const [ensure] = await oktaOps("okta.ensure_user", workflowId);
    expect(ensure).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("crash after the membership may have been added; the stale owner completing late writes nothing", async () => {
    const world = oktaWorld();
    let resume!: () => void;
    world.okta.addBehaviors.push({ writeThenHold: new Promise<void>((r) => (resume = r)) });
    const { ids, workflowId } = await authorized(["okta-engineering-group"]);
    const id = ids["okta-engineering-group"]!;
    const stale = provisioner(world, { ownerId: "stale" }).service.provisionOktaAccess({
      accessRequestId: id,
    });
    const staleOutcome = stale.then(
      (r) => (r.replayed ? "converged-without-writes" : "wrote"),
      (e: OktaProvisioningError) => e.code,
    );
    await new Promise((r) => setTimeout(r, 150));
    await handle.db.execute(
      sql`UPDATE external_operations SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE workflow_id = ${workflowId} AND operation_type = 'okta.add_group_membership'`,
    );
    const recovered = await provisioner(world, { ownerId: "recovery" }).service.provisionOktaAccess(
      { accessRequestId: id },
    );
    expect(recovered.status).toBe("PROVISIONED");
    resume();
    expect(await staleOutcome).toBe("converged-without-writes");
    expect([world.okta.adds, world.okta.memberships.size]).toEqual([1, 1]);
    expect(await auditFor(workflowId, "resource.provisioned")).toHaveLength(1);
    const row = await requestRow(id);
    expect([row.status, row.version]).toEqual(["PROVISIONED", 3]);
    // Replay after success.
    expect(
      (await provisioner(world).service.provisionOktaAccess({ accessRequestId: id })).replayed,
    ).toBe(true);
  });
});
