import { createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import { accessRequests, createDatabase, outboxEvents, type DatabaseHandle } from "@aoo/db";
import {
  createAccessAuthorizationService,
  createExternalOperationService,
  createProvisioningCoordinator,
  createRoleAccessRecommendationService,
  createWorkflowService,
} from "@aoo/orchestrator";
import { loadPolicyRegistry } from "@aoo/policy";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { offerSignedEvent, signedRequest, testConfig } from "../helpers.js";

const ADMIN_TOKEN = "test-onboarding-admin-token-0123456789abcdef";
let app: FastifyInstance;
let handle: DatabaseHandle;

beforeAll(async () => {
  app = await buildApp(
    testConfig({ DATABASE_URL: inject("databaseUrl"), ONBOARDING_ADMIN_TOKEN: ADMIN_TOKEN }),
  );
  handle = createDatabase(inject("databaseUrl"));
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

/** A hire whose cursor-license (provider MANUAL) awaits an operator, plus an OKTA request. */
async function manualWorkflow() {
  const req = signedRequest(offerSignedEvent());
  const intake = await app.inject({
    method: "POST",
    url: "/webhooks/hris",
    payload: req.body,
    headers: req.headers,
  });
  const workflowId = intake.json().workflowId as string;
  const db = handle.db;
  const workflows = createWorkflowService(db);
  const catalogs = loadCatalogRegistry();
  const wf = (await workflows.getWorkflow(workflowId))!.workflow;
  await workflows.transition({
    workflowId,
    to: "ACCESS_PLANNING",
    expectedVersion: wf.version,
    actor: "test",
  });
  const agent = createRoleAccessAgent({
    provider: createScriptedModelProvider([outputOf("cursor-license", "okta-engineering-group")]),
    sleep: async () => {},
  });
  const { agentRunId } = await createRoleAccessRecommendationService(db, {
    agent,
    catalogs,
  }).recommendAccess({ workflowId });
  const authz = await createAccessAuthorizationService(db, {
    policies: loadPolicyRegistry(catalogs),
    catalogs,
    workflows,
    externalOperations: createExternalOperationService(db, {}),
  }).authorizeAgentRun({ agentRunId });
  // No providers configured: OKTA is blocked; the MANUAL resource moves to MANUAL_ACTION_REQUIRED.
  await createProvisioningCoordinator(db, { catalogs, workflows }).coordinateProvisioning({
    workflowId,
  });
  const ids = Object.fromEntries(authz.resources.map((r) => [r.resourceId, r.accessRequestId]));
  return { workflowId, manualId: ids["cursor-license"]!, oktaId: ids["okta-engineering-group"]! };
}

const complete = (id: string, evidence: string, headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: `/admin/access-requests/${id}/manual-complete`,
    headers: { "content-type": "application/json", ...headers },
    payload: { evidence },
  });
const statusOf = async (id: string) =>
  (await handle.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;
const hr = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-operator-id": "hr.alice" };

describe("manual resource completion through the API (real PostgreSQL)", () => {
  it("unauthorized callers change nothing; an operator completes it once, idempotently, with a wake", async () => {
    const { workflowId, manualId, oktaId } = await manualWorkflow();
    expect((await statusOf(manualId)).status).toBe("MANUAL_ACTION_REQUIRED");
    for (const headers of [
      { "x-operator-id": "hr.alice" },
      {
        authorization: "Bearer wrong-token-0123456789abcdef-0123456789",
        "x-operator-id": "hr.alice",
      },
    ]) {
      expect((await complete(manualId, "Seat assigned, ticket ABC-123", headers)).statusCode).toBe(
        401,
      );
    }
    expect((await statusOf(manualId)).status).toBe("MANUAL_ACTION_REQUIRED");

    const okta = await complete(oktaId, "Added to the Okta group by hand", hr);
    expect([okta.statusCode, okta.json().error]).toEqual([409, "PROVIDER_NOT_MANUAL"]);
    const secret = await complete(manualId, "token=abcdef0123456789 for the seat", hr);
    expect([secret.statusCode, secret.json().error]).toEqual([400, "INVALID_EVIDENCE"]);

    const done = await complete(manualId, "Seat assigned, ticket ABC-123", hr);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      status: "PROVISIONED",
      changed: true,
      completedBy: "hr.alice",
    });
    expect(await statusOf(manualId)).toMatchObject({
      status: "PROVISIONED",
      manualCompletedBy: "hr.alice",
      manualEvidence: "Seat assigned, ticket ABC-123",
    });
    expect((await complete(manualId, "Seat assigned, ticket ABC-123", hr)).json()).toMatchObject({
      changed: false,
    });
    const rewrite = await complete(manualId, "Some other story entirely", hr);
    expect([rewrite.statusCode, rewrite.json().error]).toEqual([409, "MANUAL_ALREADY_COMPLETED"]);
    const wakes = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, workflowId),
          sql`${outboxEvents.payload}->>'reason' = 'MANUAL_RESOURCE_COMPLETED'`,
        ),
      );
    expect(wakes).toHaveLength(1);
  });
});
