import { createHash } from "node:crypto";
import {
  CatalogError,
  canonicalJson,
  type CatalogRegistry,
  type ResourceCatalog,
} from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  agentRecommendations,
  agentRuns,
  approvals,
  auditEvents,
  employees,
  externalOperations,
  type AccessDecision,
  type AccessRequest,
  type AgentRecommendation,
  type Database,
} from "@aoo/db";
import {
  PolicyError,
  policySubjectFromEmployee,
  type PolicyEngine,
  type PolicyRegistry,
  type PolicySubject,
} from "@aoo/policy";
import type { WorkflowState } from "@aoo/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { InvalidTransitionError, WorkflowVersionConflictError } from "../errors.js";
import { noopLogger, type EventLogger } from "../events/types.js";
import { ExternalOperationError } from "../external-operations/errors.js";
import type { ExternalOperationService } from "../external-operations/service.js";
import { isTerminal } from "../state-machine.js";
import { createProvisioningPlan } from "../provisioning/plan.js";
import type { TransitionOptions, WorkflowService } from "../workflow-service.js";

export const AUTHORIZATION_ACTOR = "access-authorization";

export type AuthorizationErrorCode =
  | "INVALID_INPUT"
  | "AGENT_RUN_NOT_FOUND"
  /** The agent run is RUNNING (retryable) or FAILED: there is no recommendation set to authorize. */
  | "AGENT_RUN_NOT_SUCCEEDED"
  /** Persisted recommendation rows don't match the run's recorded count. */
  | "RECOMMENDATIONS_MISSING"
  /** The run's canonical fact snapshot is incomplete or not canonical. */
  | "INVALID_FACTS_SNAPSHOT"
  /** The run's catalog version/hash is not a released catalog. */
  | "CATALOG_UNAVAILABLE"
  /** The policy version is not released, or its hash doesn't match the recorded one. */
  | "POLICY_UNAVAILABLE"
  /** The policy is bound to a different catalog than the one the agent run used. */
  | "POLICY_CATALOG_MISMATCH"
  /** The run was already authorized under another policy version: never silently re-authorized. */
  | "POLICY_VERSION_LOCKED"
  | "WORKFLOW_NOT_ACTIVE"
  /** Concurrent workflow changes kept conflicting; retry. */
  | "WORKFLOW_CONFLICT"
  /** A stored decision disagrees with its logical inputs; needs investigation. */
  | "DECISION_INTEGRITY";

/** An orchestration/system failure. A DENY is a normal outcome and never an error. */
export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;
  readonly retryable: boolean;
  readonly agentRunId: string | undefined;

  constructor(
    code: AuthorizationErrorCode,
    message: string,
    options: { retryable?: boolean; agentRunId?: string | undefined } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.agentRunId = options.agentRunId;
  }
}

export interface AuthorizedResource {
  readonly resourceId: string;
  readonly accessDecisionId: string;
  readonly accessRequestId: string;
  readonly decision: AccessDecision["decision"];
  readonly matchedRuleId: string;
  readonly reasonCode: string;
  readonly explanation: string;
  /** Per-resource lifecycle state (the authority for this resource). */
  readonly status: AccessRequest["status"];
  readonly externalOperationId: string | null;
  readonly externalOperationStatus: string | null;
  /** ServiceNow ticket number, once the M4B operation has created and verified it. */
  readonly ticketNumber: string | null;
  readonly approvalId: string | null;
  /** Catalog dependencies (metadata for later provisioning; never turned into decisions). */
  readonly dependsOn: readonly string[];
  /** False when the decision already existed (replay). */
  readonly created: boolean;
}

export interface ResourceFailure {
  readonly resourceId: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
}

export interface AuthorizationResult {
  readonly agentRunId: string;
  readonly workflowId: string;
  /** HRIS employee id. */
  readonly employeeId: string;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  /** The agent run's fact snapshot used for every decision. */
  readonly facts: {
    readonly departmentCode: string;
    readonly roleFamilyCode: string;
    readonly employmentType: string;
    readonly employeeFactsSourceEventId: string;
  };
  /** True when every decision already existed (nothing new was decided). */
  readonly replayed: boolean;
  /** True when every recommended resource has a persisted decision and state. */
  readonly complete: boolean;
  readonly resources: readonly AuthorizedResource[];
  readonly failures: readonly ResourceFailure[];
  readonly summary: {
    readonly total: number;
    readonly allowed: number;
    readonly denied: number;
    readonly requiresApproval: number;
    readonly failed: number;
  };
  readonly workflowState: WorkflowState;
}

export interface AccessAuthorizationService {
  /**
   * Authorizes a completed Role Access Agent run: one policy decision per recommended resource,
   * using the run's own fact snapshot and catalog version, and routes REQUIRES_APPROVAL resources
   * into the M4B ServiceNow path. Idempotent: re-running returns the existing decisions. Makes
   * no model call and provisions nothing.
   */
  authorizeAgentRun(input: {
    agentRunId: string;
    /** Explicit released policy version (replay/testing); default is the current policy. */
    policyVersion?: string;
  }): Promise<AuthorizationResult>;
}

export interface AccessAuthorizationServiceOptions {
  policies: PolicyRegistry;
  catalogs: CatalogRegistry;
  workflows: WorkflowService;
  externalOperations: ExternalOperationService;
  logger?: EventLogger;
  actor?: string;
}

const clock = sql`clock_timestamp()`;

const InputSchema = z.strictObject({
  agentRunId: z.uuid(),
  policyVersion: z
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    .optional(),
});

const REQUEST_STATUS = {
  ALLOW: "READY_FOR_PROVISIONING",
  DENY: "DENIED",
  REQUIRES_APPROVAL: "AWAITING_APPROVAL",
} as const;

const DECISION_AUDIT = {
  ALLOW: "access.allowed",
  DENY: "access.denied",
  REQUIRES_APPROVAL: "access.approval_required",
} as const;

export function logicalDecisionKey(input: {
  agentRunId: string;
  resourceId: string;
  catalogVersion: string;
  catalogHash: string;
  policyVersion: string;
  policyHash: string;
  employeeFactsSourceEventId: string;
  departmentCode: string;
  roleFamilyCode: string;
  employmentType: string;
}): string {
  return `access-decision:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

export function createAccessAuthorizationService(
  db: Database,
  options: AccessAuthorizationServiceOptions,
): AccessAuthorizationService {
  const { policies, catalogs, workflows, externalOperations: extOps } = options;
  const logger = options.logger ?? noopLogger;
  const actor = options.actor ?? AUTHORIZATION_ACTOR;

  /** Idempotent transition with re-read on version conflicts. Returns the resulting state. */
  async function transitionOnce(
    workflowId: string,
    to: WorkflowState,
    idempotencyKey: string,
    correlationId: string,
    agentRunId: string,
    effects?: TransitionOptions["effects"],
  ): Promise<WorkflowState> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const details = await workflows.getWorkflow(workflowId);
      if (!details) throw new AuthorizationError("WORKFLOW_NOT_ACTIVE", "workflow not found");
      try {
        const wf = await workflows.transition(
          {
            workflowId,
            to,
            expectedVersion: details.workflow.version,
            actor,
            correlationId,
            idempotencyKey,
          },
          effects ? { effects } : {},
        );
        return wf.state;
      } catch (err) {
        if (err instanceof WorkflowVersionConflictError) continue;
        if (err instanceof InvalidTransitionError) return details.workflow.state;
        throw err;
      }
    }
    throw new AuthorizationError("WORKFLOW_CONFLICT", "workflow kept changing concurrently", {
      retryable: true,
      agentRunId,
    });
  }

  async function describe(request: AccessRequest) {
    if (!request.externalOperationId)
      return { status: null, ticket: null, approvalId: request.approvalId };
    const [op] = await db
      .select({ status: externalOperations.status, ticket: externalOperations.externalReference })
      .from(externalOperations)
      .where(eq(externalOperations.id, request.externalOperationId));
    const [approval] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.externalOperationId, request.externalOperationId));
    return {
      status: op?.status ?? null,
      ticket: op?.ticket ?? null,
      approvalId: request.approvalId ?? approval?.id ?? null,
    };
  }

  return {
    async authorizeAgentRun(rawInput) {
      const parsed = InputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new AuthorizationError("INVALID_INPUT", "authorizeAgentRun needs an agent run uuid");
      }
      const { agentRunId, policyVersion: requestedPolicy } = parsed.data;

      // 1. The completed agent run, its recommendations and its employee.
      const [found] = await db
        .select({ run: agentRuns, employee: employees })
        .from(agentRuns)
        .innerJoin(employees, eq(employees.id, agentRuns.employeeId))
        .where(eq(agentRuns.id, agentRunId));
      if (!found)
        throw new AuthorizationError("AGENT_RUN_NOT_FOUND", `agent run ${agentRunId} not found`);
      const { run, employee } = found;
      if (run.status !== "SUCCEEDED") {
        throw new AuthorizationError(
          "AGENT_RUN_NOT_SUCCEEDED",
          `agent run is ${run.status}; only a completed recommendation set can be authorized`,
          { retryable: run.status === "RUNNING", agentRunId },
        );
      }
      const recommendations: AgentRecommendation[] = await db
        .select()
        .from(agentRecommendations)
        .where(eq(agentRecommendations.agentRunId, run.id))
        .orderBy(asc(agentRecommendations.resourceId));
      if (recommendations.length !== run.recommendationCount) {
        throw new AuthorizationError(
          "RECOMMENDATIONS_MISSING",
          `agent run records ${run.recommendationCount} recommendations but ${recommendations.length} rows exist`,
          { agentRunId },
        );
      }

      // 2. The run's own fact snapshot (never the employee's current row).
      const facts = {
        departmentCode: run.departmentCode,
        roleFamilyCode: run.roleFamilyCode,
        employmentType: run.employmentType,
        employeeFactsSourceEventId: run.factsHrisEventId,
      };
      let subject: PolicySubject;
      try {
        subject = policySubjectFromEmployee({
          hrisEmployeeId: employee.hrisEmployeeId,
          departmentCode: facts.departmentCode,
          roleFamilyCode: facts.roleFamilyCode,
          employmentType: facts.employmentType,
        });
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        throw new AuthorizationError("INVALID_FACTS_SNAPSHOT", err.message, { agentRunId });
      }

      // 3. The exact catalog release the run used.
      let catalog: ResourceCatalog;
      try {
        catalog = catalogs.resolve({
          catalogVersion: run.catalogVersion,
          catalogHash: run.catalogHash,
        });
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        throw new AuthorizationError("CATALOG_UNAVAILABLE", err.message, { agentRunId });
      }

      // 4. The policy: locked to the recorded version once any decision exists.
      const existing = await db
        .select({
          policyVersion: accessDecisions.policyVersion,
          policyHash: accessDecisions.policyHash,
        })
        .from(accessDecisions)
        .where(eq(accessDecisions.agentRunId, run.id));
      const recorded = new Set(existing.map((d) => `${d.policyVersion}|${d.policyHash}`));
      if (recorded.size > 1) {
        throw new AuthorizationError(
          "DECISION_INTEGRITY",
          "run has decisions under several policies",
          {
            agentRunId,
          },
        );
      }
      let engine: PolicyEngine;
      try {
        if (existing.length > 0) {
          const locked = existing[0]!;
          if (requestedPolicy !== undefined && requestedPolicy !== locked.policyVersion) {
            throw new AuthorizationError(
              "POLICY_VERSION_LOCKED",
              `run was authorized under policy ${locked.policyVersion}; not re-authorizing under ${requestedPolicy}`,
              { agentRunId },
            );
          }
          engine = policies.resolve(locked);
        } else {
          engine = requestedPolicy !== undefined ? policies.get(requestedPolicy) : policies.current;
        }
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        throw new AuthorizationError("POLICY_UNAVAILABLE", err.message, { agentRunId });
      }
      const bound = engine.catalog.reference;
      if (
        bound.catalogVersion !== catalog.catalogVersion ||
        bound.catalogHash !== catalog.catalogHash
      ) {
        throw new AuthorizationError(
          "POLICY_CATALOG_MISMATCH",
          `policy ${engine.policyVersion} is bound to catalog ${bound.catalogVersion}, the agent run used ${catalog.catalogVersion}`,
          { agentRunId },
        );
      }

      // 5. Workflow phase: ACCESS_PLANNING → POLICY_REVIEW (once per run).
      const correlationId = `authorization:${run.id}`;
      const details = await workflows.getWorkflow(run.workflowId);
      if (!details || isTerminal(details.workflow.state) || details.workflow.state === "RECEIVED") {
        throw new AuthorizationError(
          "WORKFLOW_NOT_ACTIVE",
          `workflow is ${details?.workflow.state ?? "missing"}; authorization needs ACCESS_PLANNING or later`,
          { agentRunId },
        );
      }
      if (details.workflow.state === "ACCESS_PLANNING") {
        await transitionOnce(
          run.workflowId,
          "POLICY_REVIEW",
          `authorization-start:${run.id}`,
          correlationId,
          run.id,
        );
      }

      // 6. Each recommended resource independently. A failure is recorded and never affects
      //    the committed decisions of other resources.
      const results: AuthorizedResource[] = [];
      const failures: ResourceFailure[] = [];
      for (const rec of recommendations) {
        try {
          results.push(await authorizeResource(rec));
        } catch (err) {
          failures.push(toFailure(rec.resourceId, err));
        }
      }

      async function authorizeResource(rec: AgentRecommendation): Promise<AuthorizedResource> {
        const decision = engine.evaluate({
          subject,
          catalog: catalog.reference,
          resourceId: rec.resourceId,
        });
        const values = {
          agentRunId: run.id,
          resourceId: rec.resourceId,
          catalogVersion: catalog.catalogVersion,
          catalogHash: catalog.catalogHash,
          policyVersion: engine.policyVersion,
          policyHash: engine.policyHash,
          ...facts,
        };
        const key = logicalDecisionKey(values);

        // One transaction per resource: its decision, its lifecycle row and their audit events.
        const { decisionRow, request, created } = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(accessDecisions)
            .values({
              ...values,
              logicalDecisionKey: key,
              workflowId: run.workflowId,
              employeeId: run.employeeId,
              decision: decision.decision,
              matchedRuleId: decision.matchedRuleId,
              reasonCode: decision.reasonCode,
              explanation: decision.explanation,
            })
            .onConflictDoNothing()
            .returning();
          let decisionRow = inserted;
          if (!decisionRow) {
            [decisionRow] = await tx
              .select()
              .from(accessDecisions)
              .where(
                and(
                  eq(accessDecisions.agentRunId, run.id),
                  eq(accessDecisions.resourceId, rec.resourceId),
                ),
              );
            if (
              !decisionRow ||
              decisionRow.logicalDecisionKey !== key ||
              decisionRow.decision !== decision.decision ||
              decisionRow.matchedRuleId !== decision.matchedRuleId
            ) {
              throw new AuthorizationError(
                "DECISION_INTEGRITY",
                "a stored decision for this resource disagrees with its logical inputs",
                { agentRunId: run.id },
              );
            }
          }
          const status = REQUEST_STATUS[decisionRow.decision];
          await tx
            .insert(accessRequests)
            .values({
              workflowId: run.workflowId,
              employeeId: run.employeeId,
              agentRunId: run.id,
              accessDecisionId: decisionRow.id,
              resourceId: rec.resourceId,
              status,
              authorizedVia: status === "READY_FOR_PROVISIONING" ? "POLICY" : null,
            })
            .onConflictDoNothing({ target: accessRequests.accessDecisionId });
          const [request] = await tx
            .select()
            .from(accessRequests)
            .where(eq(accessRequests.accessDecisionId, decisionRow.id));
          if (inserted) {
            await tx
              .insert(auditEvents)
              .values({
                workflowId: run.workflowId,
                eventType: DECISION_AUDIT[decisionRow.decision],
                actor,
                correlationId,
                idempotencyKey: `access-decision:${decisionRow.id}:evaluated`,
                payload: {
                  accessDecisionId: decisionRow.id,
                  accessRequestId: request!.id,
                  agentRunId: run.id,
                  resourceId: rec.resourceId,
                  decision: decisionRow.decision,
                  matchedRuleId: decisionRow.matchedRuleId,
                  reasonCode: decisionRow.reasonCode,
                  catalogVersion: decisionRow.catalogVersion,
                  catalogHash: decisionRow.catalogHash,
                  policyVersion: decisionRow.policyVersion,
                  policyHash: decisionRow.policyHash,
                  employeeFactsSourceEventId: decisionRow.employeeFactsSourceEventId,
                },
              })
              .onConflictDoNothing();
          }
          return { decisionRow, request: request!, created: Boolean(inserted) };
        });

        // REQUIRES_APPROVAL: route through the existing M4B durable ServiceNow path (idempotent
        // by a key tied to this decision). Nothing is sent to ServiceNow here: the operation is
        // enqueued and executed by the worker with reconcile-before-create.
        let current = request;
        if (current.status === "AWAITING_APPROVAL" && !current.externalOperationId) {
          const resource = catalog.getResource(rec.resourceId);
          const { operation } = await extOps.requestServiceNowAccessRequest({
            workflowId: run.workflowId,
            employeeId: employee.hrisEmployeeId,
            resourceId: rec.resourceId,
            requestedEntitlement: resource.displayName,
            agentReason: rec.reason,
            policyDecision: "requires_approval",
            shortDescription:
              `Access approval: ${resource.displayName}`.slice(0, 110) + ` · ${decisionRow.id}`,
            actor,
            accessDecisionId: decisionRow.id,
          });
          current = await db.transaction(async (tx) => {
            await tx
              .update(accessRequests)
              .set({
                externalOperationId: operation.id,
                version: sql`${accessRequests.version} + 1`,
                updatedAt: clock,
              })
              .where(
                and(eq(accessRequests.id, current.id), isNull(accessRequests.externalOperationId)),
              );
            await tx
              .insert(auditEvents)
              .values({
                workflowId: run.workflowId,
                eventType: "access.servicenow_requested",
                actor,
                correlationId: operation.correlationKey,
                idempotencyKey: `access-request:${current.id}:servicenow-requested`,
                payload: {
                  accessRequestId: current.id,
                  accessDecisionId: decisionRow.id,
                  agentRunId: run.id,
                  resourceId: rec.resourceId,
                  externalOperationId: operation.id,
                },
              })
              .onConflictDoNothing();
            const [row] = await tx
              .select()
              .from(accessRequests)
              .where(eq(accessRequests.id, current.id));
            return row!;
          });
        }

        const link = await describe(current);
        const resourceResult: AuthorizedResource = Object.freeze({
          resourceId: rec.resourceId,
          accessDecisionId: decisionRow.id,
          accessRequestId: current.id,
          decision: decisionRow.decision,
          matchedRuleId: decisionRow.matchedRuleId,
          reasonCode: decisionRow.reasonCode,
          explanation: decisionRow.explanation,
          status: current.status,
          externalOperationId: current.externalOperationId,
          externalOperationStatus: link.status,
          ticketNumber: link.ticket,
          approvalId: link.approvalId,
          dependsOn: catalog.getResource(rec.resourceId).dependsOn,
          created,
        });
        logger.info(
          {
            workflowId: run.workflowId,
            agentRunId: run.id,
            resourceId: rec.resourceId,
            catalogVersion: catalog.catalogVersion,
            catalogHash: catalog.catalogHash,
            policyVersion: engine.policyVersion,
            policyHash: engine.policyHash,
            decision: decisionRow.decision,
            matchedRuleId: decisionRow.matchedRuleId,
            reasonCode: decisionRow.reasonCode,
            accessRequestStatus: current.status,
            externalOperationId: current.externalOperationId,
            created,
          },
          "access decision",
        );
        return resourceResult;
      }

      // 7. Close the policy phase once every resource is decided: AWAITING_APPROVAL if any
      //    resource needs a human, otherwise PROVISIONING. M7C: the same transaction creates the
      //    workflow's provisioning plan, locked to exactly this run, and wakes provisioning.
      let workflowState = (await workflows.getWorkflow(run.workflowId))!.workflow.state;
      const complete = failures.length === 0;
      if (complete && workflowState === "POLICY_REVIEW") {
        const [{ waiting }] = (await db
          .select({ waiting: sql<number>`count(*)::int` })
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.agentRunId, run.id),
              eq(accessRequests.status, "AWAITING_APPROVAL"),
            ),
          )) as [{ waiting: number }];
        workflowState = await transitionOnce(
          run.workflowId,
          waiting > 0 ? "AWAITING_APPROVAL" : "PROVISIONING",
          `authorization-complete:${run.id}`,
          correlationId,
          run.id,
          async (tx) => {
            await createProvisioningPlan(
              tx,
              {
                workflowId: run.workflowId,
                agentRunId: run.id,
                catalogVersion: catalog.catalogVersion,
                catalogHash: catalog.catalogHash,
                policyVersion: engine.policyVersion,
                policyHash: engine.policyHash,
              },
              "AUTHORIZATION",
            );
          },
        );
      }

      const count = (d: AccessDecision["decision"]) =>
        results.filter((r) => r.decision === d).length;
      const summary = {
        total: recommendations.length,
        allowed: count("ALLOW"),
        denied: count("DENY"),
        requiresApproval: count("REQUIRES_APPROVAL"),
        failed: failures.length,
      };
      if (complete) {
        await db
          .insert(auditEvents)
          .values({
            workflowId: run.workflowId,
            eventType: "access.policy_evaluated",
            actor,
            correlationId,
            idempotencyKey: `authorization:${run.id}:evaluated`,
            payload: {
              agentRunId: run.id,
              catalogVersion: catalog.catalogVersion,
              catalogHash: catalog.catalogHash,
              policyVersion: engine.policyVersion,
              policyHash: engine.policyHash,
              employeeFactsSourceEventId: facts.employeeFactsSourceEventId,
              ...summary,
            },
          })
          .onConflictDoNothing();
      }
      logger.info(
        {
          workflowId: run.workflowId,
          agentRunId: run.id,
          policyVersion: engine.policyVersion,
          policyHash: engine.policyHash,
          catalogVersion: catalog.catalogVersion,
          catalogHash: catalog.catalogHash,
          ...summary,
          complete,
          workflowState,
        },
        "agent run authorization",
      );
      return Object.freeze({
        agentRunId: run.id,
        workflowId: run.workflowId,
        employeeId: employee.hrisEmployeeId,
        catalogVersion: catalog.catalogVersion,
        catalogHash: catalog.catalogHash,
        policyVersion: engine.policyVersion,
        policyHash: engine.policyHash,
        facts: Object.freeze({ ...facts }),
        replayed: results.length > 0 && results.every((r) => !r.created),
        complete,
        resources: Object.freeze(results),
        failures: Object.freeze(failures),
        summary: Object.freeze(summary),
        workflowState,
      });
    },
  };
}

function toFailure(resourceId: string, err: unknown): ResourceFailure {
  if (err instanceof AuthorizationError) {
    return { resourceId, code: err.code, retryable: err.retryable, message: err.message };
  }
  if (err instanceof PolicyError) {
    return { resourceId, code: `POLICY_${err.code}`, retryable: false, message: err.message };
  }
  if (err instanceof ExternalOperationError) {
    return {
      resourceId,
      code: `SERVICENOW_${err.code}`,
      retryable: err.retryable,
      message: err.message,
    };
  }
  // Database or unexpected errors: no raw messages (they can carry SQL parameters).
  return {
    resourceId,
    code: "PERSISTENCE",
    retryable: true,
    message: `persisting the decision failed (${(err as Error)?.name ?? "Error"})`,
  };
}
