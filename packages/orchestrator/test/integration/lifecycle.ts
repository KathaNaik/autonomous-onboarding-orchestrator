import { randomUUID } from "node:crypto";
import { createOnboardingPlanAgent, createRoleAccessAgent } from "@aoo/agents";
import { createScriptedModelProvider, outputOf, planOutputOf } from "@aoo/agents/testing";
import { loadCatalogRegistry } from "@aoo/catalog";
import { accessRequests, externalOperations, type Database } from "@aoo/db";
import type { GitHubTarget } from "@aoo/github";
import { loadPolicyRegistry } from "@aoo/policy";
import type { HrisOfferSignedEvent } from "@aoo/shared";
import { eq, sql } from "drizzle-orm";
import {
  createAccessAuthorizationService,
  createApprovalService,
  createEventHandlers,
  createExternalOperationService,
  createGitHubHandlers,
  createGitHubIdentityService,
  createGitHubProvisioningService,
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
  noopLogger,
} from "../../src/index.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeServiceNow } from "./fake-servicenow.js";
import { newOfferSignedEvent } from "./helpers.js";

/**
 * (M9 tests) Builds synthetic workflows through the real services: HRIS intake → Role Access Agent
 * (scripted) → policy → approvals (M4C path) → M7C coordinator with fake GitHub/ServiceNow → M8
 * plan (scripted). Each stage is optional so a test can stop anywhere in the lifecycle.
 */
export const ENGINEER = {
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "FULL_TIME",
} as const;
export const CONTRACTOR = { ...ENGINEER, employmentType: "CONTRACTOR" } as const;

export interface LifecycleOptions {
  facts?: Partial<HrisOfferSignedEvent>;
  /** REQUIRES_APPROVAL resources: approve all except these; `"none"` leaves them pending. */
  reject?: string[];
  decideApprovals?: boolean;
  githubLogin?: string;
  /** Accept the GitHub org invitation (default true). */
  inviteActivates?: boolean;
  /** ServiceNow fulfillment outcome for every fulfillment record (default "fulfilled"). */
  fulfillment?: "fulfilled" | "pending" | "failed";
  /** Run provisioning coordination passes (default true). */
  provision?: boolean;
  /** Generate the onboarding plan through the worker path (default false). */
  completePlan?: boolean;
}

export function lifecycleFor(db: Database) {
  const catalogs = loadCatalogRegistry();
  const policies = loadPolicyRegistry(catalogs);
  const workflows = createWorkflowService(db);

  async function build(resourceIds: string[], opts: LifecycleOptions = {}) {
    const sn = new FakeServiceNow();
    const gh = new FakeGitHub();
    gh.inviteActivates = opts.inviteActivates ?? true;
    const login = opts.githubLogin ?? `m9-${randomUUID().slice(0, 8)}`;
    gh.seedUser(login);
    gh.seedTeam("aoo-backend", "AOO Backend");
    const event = newOfferSignedEvent({
      ...ENGINEER,
      ...opts.facts,
      role: "Backend Software Engineer",
      jobDescription: "Builds backend services.",
    });
    const { workflowId } = await createHrisIntakeService(db).acceptOfferSigned(event);
    const wf = (await workflows.getWorkflow(workflowId))!.workflow;
    await workflows.transition({
      workflowId,
      to: "ACCESS_PLANNING",
      expectedVersion: wf.version,
      actor: "test",
    });
    const { agentRunId } = await createRoleAccessRecommendationService(db, {
      agent: createRoleAccessAgent({
        provider: createScriptedModelProvider([outputOf(...resourceIds)]),
        sleep: async () => {},
      }),
      catalogs,
    }).recommendAccess({ workflowId });
    const snOps = createExternalOperationService(db, {
      servicenow: sn,
      correlationPrefix: "aoo-test-oar-",
      reconcile: { attempts: 1, delayMs: 1 },
    });
    const auth = await createAccessAuthorizationService(db, {
      policies,
      catalogs,
      workflows,
      externalOperations: snOps,
    }).authorizeAgentRun({ agentRunId });
    const ids = Object.fromEntries(auth.resources.map((r) => [r.resourceId, r.accessRequestId]));

    const approvalsSvc = createApprovalService(db, { servicenow: sn, workflows });
    for (const r of auth.resources.filter((x) => x.status === "AWAITING_APPROVAL")) {
      const done = await snOps.execute(r.externalOperationId!, { ownerId: "t", leaseMs: 30_000 });
      if (opts.decideApprovals === false) continue;
      sn.setApprovalState(
        done.externalId,
        opts.reject?.includes(r.resourceId) ? "rejected" : "approved",
      );
      const [op] = await db
        .select()
        .from(externalOperations)
        .where(eq(externalOperations.id, r.externalOperationId!));
      const { callbackEventId } = await approvalsSvc.recordServiceNowCallback({
        eventId: `${op!.externalId}:1`,
        instance: "dev000001",
        table: "x_0000000_autonomo_onboarding_access_request",
        sysId: op!.externalId!,
        number: op!.externalReference!,
        correlationKey: op!.correlationKey,
      });
      await approvalsSvc.processCallback(callbackEventId);
    }
    if (resourceIds.some((r) => r.startsWith("github-"))) {
      await createGitHubIdentityService(db, { catalogs }).submitClaim({
        workflowId,
        githubLogin: login,
        operatorId: "hr.test",
      });
    }

    const extOps = createExternalOperationService(db, {
      handlers: [createServiceNowFulfillmentHandler(sn), ...createGitHubHandlers(gh)],
      reconcile: { attempts: 1, delayMs: 1 },
    });
    const owner = { ownerId: "m9-test", leaseMs: 30_000 };
    const coordinator = createProvisioningCoordinator(db, {
      catalogs,
      workflows,
      servicenow: createServiceNowFulfillmentService(db, {
        catalogs,
        externalOperations: extOps,
        servicenow: sn,
        ...owner,
      }),
      github: createGitHubProvisioningService(db, {
        catalogs,
        externalOperations: extOps,
        github: gh,
        targets: new Map<string, GitHubTarget>([
          [
            "github-org-membership",
            { kind: "org", resourceId: "github-org-membership", org: gh.org },
          ],
          [
            "github-team-backend",
            {
              kind: "team",
              resourceId: "github-team-backend",
              org: gh.org,
              teamSlug: "aoo-backend",
              teamName: "AOO Backend",
            },
          ],
        ]),
        ...owner,
      }),
      reconcileIntervalMs: 600_000,
      fulfillmentReconcileIntervalMs: 120_000,
      retryDelayMs: 600_000,
      sweepIntervalMs: 600_000,
    });
    const manual = createManualProvisioningService(db, { catalogs });
    if (opts.provision !== false) {
      for (let i = 0; i < 8; i++) {
        await coordinator.coordinateProvisioning({ workflowId });
        const state = (await workflows.getWorkflow(workflowId))!.workflow.state;
        if (state !== "PROVISIONING") break;
        for (const rec of sn.records.filter((x) => x.requestKind === "fulfillment")) {
          const target = opts.fulfillment ?? "fulfilled";
          if (target !== "pending" && rec.fulfillmentState !== target)
            sn.setFulfillmentState(rec.sysId, target);
        }
        for (const row of await db
          .select()
          .from(accessRequests)
          .where(eq(accessRequests.agentRunId, agentRunId))) {
          if (row.status === "MANUAL_ACTION_REQUIRED") {
            await manual.completeManualResource({
              accessRequestId: row.id,
              operatorId: "hr.test",
              evidence: "License assigned (synthetic).",
            });
          }
        }
        await db
          .update(accessRequests)
          .set({ nextReconcileAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(accessRequests.agentRunId, agentRunId));
      }
    }
    if (opts.completePlan) {
      const available = (
        await db.select().from(accessRequests).where(eq(accessRequests.agentRunId, agentRunId))
      )
        .filter((r) => r.status === "PROVISIONED")
        .map((r) => r.resourceId);
      const plans = createOnboardingPlanService(db, {
        agent: createOnboardingPlanAgent({
          provider: createScriptedModelProvider([planOutputOf(available)]),
          sleep: async () => {},
        }),
        catalogs,
        policies,
        workflows,
        leaseMs: 30_000,
      });
      const runner = createOutboxRunner(createPostgresOutboxStore(db), {
        workerId: "m9-worker",
        batchSize: 10,
        leaseMs: 30_000,
        retry: { maxAttempts: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
        handlers: createEventHandlers({
          workflows,
          provisioning: coordinator,
          onboardingPlans: plans,
        }),
        logger: noopLogger,
        random: () => 0,
      });
      for (let i = 0; i < 20; i++) if ((await runner.runOnce()).claimed === 0) break;
    }
    return { workflowId, agentRunId, ids, sn, gh, login, catalogs, workflows };
  }

  return { build, catalogs, policies, workflows };
}
