import { createHash, randomUUID } from "node:crypto";
import {
  RecommendationContextSchema,
  RoleAccessAgentError,
  sanitizeProviderText,
  type RecommendationDependency,
  type RoleAccessAgent,
  type RoleAccessAgentInput,
} from "@aoo/agents";
import { CatalogError, canonicalJson, type CatalogRegistry } from "@aoo/catalog";
import {
  agentRecommendations,
  agentRuns,
  employees,
  hrisEventReceipts,
  onboardingWorkflows,
  type AgentRun,
  type Database,
} from "@aoo/db";
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { noopLogger, type EventLogger } from "../events/types.js";
import { withSpan } from "@aoo/telemetry";

export const ROLE_ACCESS_AGENT_NAME = "role-access";

export type RoleAccessRunErrorCode =
  | "WORKFLOW_NOT_FOUND"
  | "EMPLOYEE_MISMATCH"
  /** The employee has no canonical facts (e.g. a pre-M5C row). Fails before any model call. */
  | "INCOMPLETE_FACTS"
  /** The HRIS receipt holding the recommendation context is missing or unreadable. */
  | "CONTEXT_UNAVAILABLE"
  | "INVALID_INPUT"
  /** Another invocation holds a live lease on this logical run. Retry later. */
  | "BUSY"
  /** The run failed; `category` and `retryable` say why and whether a re-invocation may help. */
  | "RUN_FAILED"
  /** Our lease expired and another owner took the run; our result was discarded. */
  | "OWNERSHIP_LOST";

export class RoleAccessRunError extends Error {
  readonly code: RoleAccessRunErrorCode;
  readonly retryable: boolean;
  readonly agentRunId: string | undefined;
  readonly category: string | undefined;

  constructor(
    code: RoleAccessRunErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      agentRunId?: string | undefined;
      category?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.agentRunId = options.agentRunId;
    this.category = options.category;
  }
}

export interface EmployeeFactSnapshot {
  readonly departmentCode: string;
  readonly roleFamilyCode: string;
  readonly employmentType: string;
  readonly factsHrisEventId: string;
}

export interface RoleAccessRecommendationResult {
  readonly agentRunId: string;
  readonly logicalRunKey: string;
  /** True when an already SUCCEEDED run was returned without calling the model. */
  readonly replayed: boolean;
  readonly workflowId: string;
  /** HRIS employee id. */
  readonly employeeId: string;
  readonly promptVersion: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly modelConfig: string;
  /** Model the provider reported serving the successful call (null if not reported). */
  readonly servedModel: string | null;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly inputHash: string;
  /** Canonical facts associated with this run, frozen when it started. Not model output. */
  readonly facts: EmployeeFactSnapshot;
  /** Sorted by resource id, exactly as persisted. */
  readonly recommendations: readonly {
    readonly resourceId: string;
    readonly reasonCode: string;
    readonly reason: string;
    readonly confidence: number;
  }[];
  /** Catalog dependencies of the recommended resources, for later orchestration only. */
  readonly dependencies: readonly RecommendationDependency[];
  readonly latencyMs: number | null;
  readonly attempts: number;
}

export interface RoleAccessRecommendationService {
  /**
   * Recommends resources for the workflow's employee. Idempotent per logical run: repeated or
   * concurrent invocations for the same inputs reuse one run (and at most one model result).
   * Recommends only: no policy evaluation, tickets, provisioning or workflow transitions.
   */
  recommendAccess(input: {
    workflowId: string;
    /** Optional HRIS employee id; must match the workflow's employee if given. */
    employeeId?: string;
  }): Promise<RoleAccessRecommendationResult>;
}

export interface RoleAccessRecommendationServiceOptions {
  agent: RoleAccessAgent;
  catalogs: CatalogRegistry;
  ownerId?: string;
  /** Lease on a claimed run; the model deadline is 80% of it. */
  leaseMs?: number;
  logger?: EventLogger;
}

const clock = sql`clock_timestamp()`;
const plusMs = (ms: number) => sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;
const DEADLINE_FRACTION = 0.8;

/** Recommendation context read from the HRIS receipt of the event that supplied the facts. */
const ReceiptContextSchema = z.object({
  role: z.string(),
  department: z.string(),
  jobDescription: z.string().optional(),
});

const RecommendAccessInputSchema = z.strictObject({
  workflowId: z.uuid(),
  employeeId: z.string().min(1).max(200).optional(),
});

type RunUpdate = {
  [K in keyof typeof agentRuns.$inferInsert]?: (typeof agentRuns.$inferInsert)[K] | SQL;
};

export function createRoleAccessRecommendationService(
  db: Database,
  options: RoleAccessRecommendationServiceOptions,
): RoleAccessRecommendationService {
  const { agent, catalogs } = options;
  const ownerId = options.ownerId ?? `role-access-${randomUUID().slice(0, 8)}`;
  const leaseMs = options.leaseMs ?? 180_000;
  const logger = options.logger ?? noopLogger;

  const fence = (runId: string, token: string) =>
    and(
      eq(agentRuns.id, runId),
      eq(agentRuns.ownerToken, token),
      eq(agentRuns.status, "RUNNING"),
      gt(agentRuns.ownerExpiresAt, clock),
    );
  const releaseOwner = { ownerToken: null, ownerId: null, ownerExpiresAt: null } as const;

  async function toResult(run: AgentRun, replayed: boolean, hrisEmployeeId: string) {
    const rows = await db
      .select()
      .from(agentRecommendations)
      .where(eq(agentRecommendations.agentRunId, run.id))
      .orderBy(asc(agentRecommendations.resourceId));
    // Dependencies come from the run's own catalog version, never the current one.
    const catalog = catalogs.resolve({
      catalogVersion: run.catalogVersion,
      catalogHash: run.catalogHash,
    });
    const recommendations = rows.map((r) =>
      Object.freeze({
        resourceId: r.resourceId,
        reasonCode: r.reasonCode,
        reason: r.reason,
        confidence: r.confidence,
      }),
    );
    return Object.freeze<RoleAccessRecommendationResult>({
      agentRunId: run.id,
      logicalRunKey: run.logicalRunKey,
      replayed,
      workflowId: run.workflowId,
      employeeId: hrisEmployeeId,
      promptVersion: run.promptVersion,
      modelProvider: run.modelProvider,
      model: run.model,
      modelConfig: run.modelConfig,
      servedModel: run.servedModel,
      catalogVersion: run.catalogVersion,
      catalogHash: run.catalogHash,
      inputHash: run.inputHash,
      facts: Object.freeze({
        departmentCode: run.departmentCode,
        roleFamilyCode: run.roleFamilyCode,
        employmentType: run.employmentType,
        factsHrisEventId: run.factsHrisEventId,
      }),
      recommendations: Object.freeze(recommendations),
      dependencies: Object.freeze(
        recommendations
          .map((r) => ({
            resourceId: r.resourceId,
            dependsOn: catalog.getResource(r.resourceId).dependsOn,
          }))
          .filter((d) => d.dependsOn.length > 0),
      ),
      latencyMs: run.latencyMs,
      attempts: run.attempts,
    });
  }

  function logOutcome(
    run: Pick<
      AgentRun,
      "id" | "workflowId" | "promptVersion" | "model" | "catalogVersion" | "catalogHash"
    >,
    fields: Record<string, unknown>,
    msg: string,
  ) {
    // Metadata only: never the job description, facts payloads or provider credentials.
    logger.info(
      {
        agentRunId: run.id,
        workflowId: run.workflowId,
        agent: ROLE_ACCESS_AGENT_NAME,
        promptVersion: run.promptVersion,
        model: run.model,
        catalogVersion: run.catalogVersion,
        catalogHash: run.catalogHash,
        ...fields,
      },
      msg,
    );
  }

  return {
    async recommendAccess(rawInput) {
      const parsed = RecommendAccessInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new RoleAccessRunError("INVALID_INPUT", "recommendAccess needs a workflow uuid");
      }
      const { workflowId, employeeId: expectedEmployeeId } = parsed.data;

      // 1. Employee, canonical facts and recommendation context, read before any model call.
      const [found] = await db
        .select({ workflow: onboardingWorkflows, employee: employees })
        .from(onboardingWorkflows)
        .innerJoin(employees, eq(employees.id, onboardingWorkflows.employeeId))
        .where(eq(onboardingWorkflows.id, workflowId));
      if (!found)
        throw new RoleAccessRunError("WORKFLOW_NOT_FOUND", `workflow ${workflowId} not found`);
      const { employee } = found;
      if (expectedEmployeeId !== undefined && expectedEmployeeId !== employee.hrisEmployeeId) {
        throw new RoleAccessRunError(
          "EMPLOYEE_MISMATCH",
          "employee does not belong to the workflow",
        );
      }
      if (
        !employee.departmentCode ||
        !employee.roleFamilyCode ||
        !employee.employmentType ||
        !employee.factsHrisEventId
      ) {
        throw new RoleAccessRunError(
          "INCOMPLETE_FACTS",
          "employee has no canonical facts; recommendation refused before any model call",
        );
      }
      const facts: EmployeeFactSnapshot = {
        departmentCode: employee.departmentCode,
        roleFamilyCode: employee.roleFamilyCode,
        employmentType: employee.employmentType,
        factsHrisEventId: employee.factsHrisEventId,
      };
      const [receipt] = await db
        .select({ payload: hrisEventReceipts.payload })
        .from(hrisEventReceipts)
        .where(eq(hrisEventReceipts.eventId, facts.factsHrisEventId));
      const receiptContext = ReceiptContextSchema.safeParse(receipt?.payload);
      if (!receiptContext.success) {
        throw new RoleAccessRunError(
          "CONTEXT_UNAVAILABLE",
          "the HRIS receipt that supplied the employee facts is missing or unreadable",
        );
      }
      const context = RecommendationContextSchema.safeParse({
        role: receiptContext.data.role,
        department: receiptContext.data.department,
        jobDescription: receiptContext.data.jobDescription ?? null,
      });
      if (!context.success) {
        throw new RoleAccessRunError("INVALID_INPUT", "recommendation context is invalid");
      }

      // 2. Exact catalog snapshot and deterministic logical run key.
      const catalog = catalogs.current;
      const agentInput: RoleAccessAgentInput = {
        workflowId,
        employeeId: employee.hrisEmployeeId,
        context: context.data,
        catalog,
      };
      let inputHash: string;
      try {
        inputHash = agent.prepare(agentInput).inputHash;
      } catch (err) {
        if (err instanceof RoleAccessAgentError) {
          throw new RoleAccessRunError("INVALID_INPUT", err.message);
        }
        throw err;
      }
      const keyMaterial = {
        agent: ROLE_ACCESS_AGENT_NAME,
        workflowId,
        employeeId: employee.id,
        factsHrisEventId: facts.factsHrisEventId,
        inputHash,
        catalogVersion: catalog.catalogVersion,
        catalogHash: catalog.catalogHash,
        promptVersion: agent.promptVersion,
        modelConfig: agent.modelConfig,
      };
      const logicalRunKey = `${ROLE_ACCESS_AGENT_NAME}:${createHash("sha256").update(canonicalJson(keyMaterial)).digest("hex")}`;

      // 3. Claim the logical run (or replay / refuse).
      const token = randomUUID();
      const claim = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(agentRuns)
          .values({
            logicalRunKey,
            agent: ROLE_ACCESS_AGENT_NAME,
            workflowId,
            employeeId: employee.id,
            promptVersion: agent.promptVersion,
            modelProvider: agent.provider,
            model: agent.model,
            modelConfig: agent.modelConfig,
            catalogVersion: catalog.catalogVersion,
            catalogHash: catalog.catalogHash,
            inputHash,
            ...facts,
            status: "RUNNING",
            ownerToken: token,
            ownerId,
            ownerExpiresAt: plusMs(leaseMs) as unknown as Date,
            startedAt: clock as unknown as Date,
          })
          .onConflictDoNothing({ target: agentRuns.logicalRunKey })
          .returning();
        if (inserted) return { kind: "claimed" as const, run: inserted };
        const [row] = await tx
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.logicalRunKey, logicalRunKey))
          .for("update");
        if (!row) throw new Error("agent run vanished during claim");
        if (row.status === "SUCCEEDED") return { kind: "replay" as const, run: row };
        if (row.status === "FAILED" && !row.errorRetryable)
          return { kind: "failed" as const, run: row };
        const [{ now }] = (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`))
          .rows as [{ now: Date }];
        if (row.status === "RUNNING" && row.ownerExpiresAt && row.ownerExpiresAt > new Date(now)) {
          return { kind: "busy" as const, run: row };
        }
        // Expired lease (crashed owner) or a retryable failure: reclaim the same row.
        const reset: RunUpdate = {
          status: "RUNNING",
          ownerToken: token,
          ownerId,
          ownerExpiresAt: plusMs(leaseMs),
          attempts: sql`${agentRuns.attempts} + 1`,
          startedAt: clock,
          completedAt: null,
          latencyMs: null,
          modelCalls: null,
          servedModel: null,
          recommendationCount: null,
          inputTokens: null,
          outputTokens: null,
          errorCategory: null,
          errorMessage: null,
          errorRetryable: null,
          errorDetail: null,
          updatedAt: clock,
        };
        const [reclaimed] = await tx
          .update(agentRuns)
          .set(reset as never)
          .where(eq(agentRuns.id, row.id))
          .returning();
        return { kind: "claimed" as const, run: reclaimed! };
      });

      if (claim.kind === "replay") {
        logOutcome(
          claim.run,
          { outcome: "REPLAYED", recommendationCount: claim.run.recommendationCount },
          "role access run replayed",
        );
        return toResult(claim.run, true, employee.hrisEmployeeId);
      }
      if (claim.kind === "failed") {
        throw new RoleAccessRunError(
          "RUN_FAILED",
          `role access run failed permanently (${claim.run.errorCategory})`,
          { agentRunId: claim.run.id, category: claim.run.errorCategory ?? undefined },
        );
      }
      if (claim.kind === "busy") {
        throw new RoleAccessRunError("BUSY", "another invocation is running this recommendation", {
          retryable: true,
          agentRunId: claim.run.id,
        });
      }
      const run = claim.run;

      // 4. Model call outside any transaction, bounded by the lease.
      const started = performance.now();
      const markFailed = async (
        category: string,
        message: string,
        retryable: boolean,
        detail: Record<string, unknown>,
      ) => {
        await db
          .update(agentRuns)
          .set({
            status: "FAILED",
            ...releaseOwner,
            completedAt: clock,
            latencyMs: Math.round(performance.now() - started),
            errorCategory: category,
            errorMessage: sanitizeProviderText(message),
            errorRetryable: retryable,
            errorDetail: detail,
            updatedAt: clock,
          } as never)
          .where(fence(run.id, token));
      };

      let outcome;
      try {
        outcome = await withSpan(
          "agent.role_access.recommend",
          { agentName: ROLE_ACCESS_AGENT_NAME, agentRunId: run.id, workflowId },
          () =>
            agent.recommend(agentInput, {
              signal: AbortSignal.timeout(Math.floor(leaseMs * DEADLINE_FRACTION)),
            }),
        );
      } catch (err) {
        const agentError =
          err instanceof RoleAccessAgentError
            ? err
            : new RoleAccessAgentError(
                "NETWORK",
                sanitizeProviderText(String((err as Error)?.message ?? err)),
              );
        const cap = (ids: readonly string[] | undefined) =>
          (ids ?? []).slice(0, 20).map((id) => sanitizeProviderText(id).slice(0, 100));
        await markFailed(agentError.category, agentError.message, agentError.retryable, {
          modelCalls: agentError.attempts,
          ...(agentError.httpStatus !== undefined && { httpStatus: agentError.httpStatus }),
          ...(agentError.details && {
            unknownResourceIds: cap(agentError.details.unknownResourceIds),
            disabledResourceIds: cap(agentError.details.disabledResourceIds),
            duplicateResourceIds: cap(agentError.details.duplicateResourceIds),
          }),
        });
        logOutcome(
          run,
          {
            outcome: agentError.category,
            retryable: agentError.retryable,
            latencyMs: Math.round(performance.now() - started),
          },
          "role access run failed",
        );
        throw new RoleAccessRunError(
          "RUN_FAILED",
          `role access run failed: ${agentError.category}`,
          {
            retryable: agentError.retryable,
            agentRunId: run.id,
            category: agentError.category,
          },
        );
      }

      // 5. Persist the validated recommendation set atomically with the run's completion.
      try {
        const completed = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(agentRuns)
            .set({
              status: "SUCCEEDED",
              ...releaseOwner,
              completedAt: clock,
              latencyMs: outcome.latencyMs,
              modelCalls: outcome.attempts,
              servedModel: outcome.servedModel ?? null,
              recommendationCount: outcome.recommendations.length,
              inputTokens: outcome.usage?.inputTokens ?? null,
              outputTokens: outcome.usage?.outputTokens ?? null,
              updatedAt: clock,
            } as never)
            .where(fence(run.id, token))
            .returning();
          if (!row) {
            throw new RoleAccessRunError(
              "OWNERSHIP_LOST",
              "lease on the agent run expired or was taken over; result discarded",
              { retryable: true, agentRunId: run.id },
            );
          }
          if (outcome.recommendations.length > 0) {
            await tx.insert(agentRecommendations).values(
              outcome.recommendations.map((r) => ({
                agentRunId: run.id,
                resourceId: r.resourceId,
                reasonCode: r.reasonCode,
                reason: r.reason,
                confidence: r.confidence,
              })),
            );
          }
          return row;
        });
        logOutcome(
          completed,
          {
            outcome: "SUCCEEDED",
            latencyMs: outcome.latencyMs,
            recommendationCount: outcome.recommendations.length,
            modelCalls: outcome.attempts,
          },
          "role access run succeeded",
        );
        return toResult(completed, false, employee.hrisEmployeeId);
      } catch (err) {
        if (err instanceof RoleAccessRunError) throw err;
        // Rolled back: nothing of this attempt persisted. Mark it retryable (fenced).
        await markFailed(
          "PERSISTENCE",
          `persisting recommendations failed: ${(err as Error).message}`,
          true,
          {},
        ).catch(() => {});
        logOutcome(run, { outcome: "PERSISTENCE", retryable: true }, "role access run failed");
        if (err instanceof CatalogError) throw err;
        throw new RoleAccessRunError("RUN_FAILED", "persisting recommendations failed", {
          retryable: true,
          agentRunId: run.id,
          category: "PERSISTENCE",
        });
      }
    },
  };
}
