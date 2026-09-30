import { createHash, randomUUID } from "node:crypto";
import {
  OnboardingPlanAgentError,
  sanitizeProviderText,
  type OnboardingPlanAgent,
  type OnboardingPlanAgentResult,
} from "@aoo/agents";
import { canonicalJson, type CatalogRegistry } from "@aoo/catalog";
import {
  auditEvents,
  onboardingPlanRuns,
  onboardingPlans,
  onboardingWorkflows,
  type Database,
  type OnboardingPlan,
  type OnboardingPlanRun,
} from "@aoo/db";
import type { PolicyRegistry } from "@aoo/policy";
import { and, eq, gt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { InvalidTransitionError, WorkflowVersionConflictError } from "../errors.js";
import { noopLogger, type EventLogger } from "../events/types.js";
import type { WorkflowService } from "../workflow-service.js";
import {
  OnboardingContextError,
  loadOnboardingPlanContext,
  type OnboardingContextErrorCode,
} from "./context.js";
import { enqueueOnboardingPlanGeneration } from "./wake.js";
import { withSpan } from "@aoo/telemetry";

export const ONBOARDING_PLAN_AGENT_NAME = "onboarding-plan";
export const ONBOARDING_PLAN_ACTOR = "onboarding-plan";

export type OnboardingPlanErrorCode =
  | OnboardingContextErrorCode
  | "INVALID_INPUT"
  /** Another invocation holds a live lease on this logical run. Retry later. */
  | "BUSY"
  /** The run failed; `retryable` says whether a re-invocation may help. */
  | "RUN_FAILED"
  /** Our lease expired and another owner took the run; our result was discarded. */
  | "OWNERSHIP_LOST"
  /** Concurrent workflow changes kept conflicting. */
  | "WORKFLOW_CONFLICT";

export class OnboardingPlanError extends Error {
  readonly code: OnboardingPlanErrorCode;
  readonly retryable: boolean;
  /** True for deterministic context failures recorded as `onboarding_plan.generation_blocked`. */
  readonly blocked: boolean;
  readonly runId: string | undefined;
  readonly category: string | undefined;

  constructor(
    code: OnboardingPlanErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      blocked?: boolean;
      runId?: string;
      category?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.blocked = options.blocked ?? false;
    this.runId = options.runId;
    this.category = options.category;
  }
}

export interface OnboardingPlanGenerationResult {
  /**
   * COMPLETED: this call persisted the plan and moved the workflow to COMPLETED.
   * ALREADY_COMPLETED: an accepted plan already existed (no model call).
   * NOT_APPLICABLE: the workflow isn't in ONBOARDING_GENERATION (and has no accepted plan).
   */
  readonly outcome: "COMPLETED" | "ALREADY_COMPLETED" | "NOT_APPLICABLE";
  readonly workflowId: string;
  readonly workflowState: string | null;
  readonly onboardingPlanId: string | null;
  readonly onboardingPlanRunId: string | null;
  /** Model calls made by THIS invocation (0 on replay). */
  readonly modelCalls: number;
}

export interface AcceptedOnboardingPlan {
  readonly onboardingPlanId: string;
  readonly workflowId: string;
  readonly onboardingPlanRunId: string;
  readonly provisioningPlanId: string;
  readonly sourceAgentRunId: string;
  readonly promptVersion: string;
  readonly servedModel: string | null;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly summary: string;
  readonly tasks: readonly Record<string, unknown>[];
  readonly createdAt: Date;
}

export interface OnboardingPlanService {
  /**
   * Generates the onboarding plan of a workflow in ONBOARDING_GENERATION and completes the
   * workflow. Idempotent: duplicate or concurrent invocations share one logical run, at most one
   * plan is accepted and the workflow reaches COMPLETED once. Reads access state only.
   */
  generatePlan(input: { workflowId: string }): Promise<OnboardingPlanGenerationResult>;
  /** The accepted plan of a workflow, or null (read-only). */
  getAcceptedPlan(workflowId: string): Promise<AcceptedOnboardingPlan | null>;
  /**
   * Recovery: enqueues a de-duplicated `onboarding.plan.generate` for every workflow in
   * ONBOARDING_GENERATION without an accepted plan (unless blocked or failed permanently).
   */
  enqueueDueGenerations(input?: { limit?: number }): Promise<{ enqueued: number }>;
}

export interface OnboardingPlanServiceOptions {
  agent: OnboardingPlanAgent;
  catalogs: CatalogRegistry;
  policies: PolicyRegistry;
  workflows: WorkflowService;
  ownerId?: string;
  /** Lease on a claimed run; the model deadline is 80% of it. */
  leaseMs?: number;
  /** Bucket for de-duplicating recovery wakes across workers and sweeps. */
  sweepIntervalMs?: number;
  logger?: EventLogger;
}

const clock = sql`clock_timestamp()`;
const plusMs = (ms: number) => sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;
const DEADLINE_FRACTION = 0.8;
const InputSchema = z.strictObject({ workflowId: z.uuid() });

type RunUpdate = {
  [K in keyof typeof onboardingPlanRuns.$inferInsert]?:
    (typeof onboardingPlanRuns.$inferInsert)[K] | SQL;
};

export function createOnboardingPlanService(
  db: Database,
  options: OnboardingPlanServiceOptions,
): OnboardingPlanService {
  const { agent, catalogs, policies, workflows } = options;
  const ownerId = options.ownerId ?? `onboarding-plan-${randomUUID().slice(0, 8)}`;
  const leaseMs = options.leaseMs ?? 180_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const logger = options.logger ?? noopLogger;

  const fence = (runId: string, token: string) =>
    and(
      eq(onboardingPlanRuns.id, runId),
      eq(onboardingPlanRuns.ownerToken, token),
      eq(onboardingPlanRuns.status, "RUNNING"),
      gt(onboardingPlanRuns.ownerExpiresAt, clock),
    );
  const releaseOwner = { ownerToken: null, ownerId: null, ownerExpiresAt: null } as const;

  const audit = (
    workflowId: string,
    eventType: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ) =>
    db
      .insert(auditEvents)
      .values({
        workflowId,
        eventType,
        actor: ONBOARDING_PLAN_ACTOR,
        correlationId: `onboarding-plan:${workflowId}`,
        idempotencyKey,
        payload,
      })
      .onConflictDoNothing();

  async function acceptedPlanRow(workflowId: string): Promise<OnboardingPlan | undefined> {
    const [row] = await db
      .select()
      .from(onboardingPlans)
      .where(eq(onboardingPlans.workflowId, workflowId));
    return row;
  }

  async function workflowState(workflowId: string) {
    const [row] = await db
      .select({ state: onboardingWorkflows.state })
      .from(onboardingWorkflows)
      .where(eq(onboardingWorkflows.id, workflowId));
    return row?.state ?? null;
  }

  function logOutcome(
    run: Pick<OnboardingPlanRun, "id" | "workflowId">,
    fields: object,
    msg: string,
  ) {
    // Metadata only: never the job description, plan text, prompts or credentials.
    logger.info(
      {
        onboardingPlanRunId: run.id,
        workflowId: run.workflowId,
        agent: ONBOARDING_PLAN_AGENT_NAME,
        promptVersion: agent.promptVersion,
        model: agent.model,
        ...fields,
      },
      msg,
    );
  }

  async function generatePlan(rawInput: { workflowId: string }) {
    const parsed = InputSchema.safeParse(rawInput);
    if (!parsed.success)
      throw new OnboardingPlanError("INVALID_INPUT", "generatePlan needs a workflow uuid");
    const { workflowId } = parsed.data;

    // 0. Replay: an accepted plan ends the work, whatever the delivery (no model call).
    const existing = await acceptedPlanRow(workflowId);
    const state = await workflowState(workflowId);
    if (existing) {
      return {
        outcome: "ALREADY_COMPLETED" as const,
        workflowId,
        workflowState: state,
        onboardingPlanId: existing.id,
        onboardingPlanRunId: existing.onboardingPlanRunId,
        modelCalls: 0,
      };
    }
    if (state !== "ONBOARDING_GENERATION") {
      return {
        outcome: "NOT_APPLICABLE" as const,
        workflowId,
        workflowState: state,
        onboardingPlanId: null,
        onboardingPlanRunId: null,
        modelCalls: 0,
      };
    }

    // 1. Exact historical context, validated before any model call.
    let ctx;
    try {
      ctx = await loadOnboardingPlanContext(db, { catalogs, policies }, workflowId);
    } catch (err) {
      if (!(err instanceof OnboardingContextError)) throw err;
      await audit(
        workflowId,
        "onboarding_plan.generation_blocked",
        `onboarding-plan:${workflowId}:blocked:${err.code}`,
        {
          code: err.code,
          ...err.detail,
        },
      );
      logger.warn({ workflowId, code: err.code }, "onboarding plan generation blocked");
      throw new OnboardingPlanError(err.code, err.message, { blocked: true });
    }
    const plan = ctx.provisioningPlan;
    const agentInput = {
      modelInput: ctx.modelInput,
      catalogResourceIds: ctx.catalogResourceIds,
      forbiddenTerms: ctx.forbiddenTerms,
    };
    let prepared;
    try {
      prepared = agent.prepare(agentInput);
    } catch (err) {
      if (err instanceof OnboardingPlanAgentError) {
        throw new OnboardingPlanError("INVALID_INPUT", err.message, { blocked: true });
      }
      throw err;
    }
    const keyMaterial = {
      agent: ONBOARDING_PLAN_AGENT_NAME,
      workflowId,
      provisioningPlanId: plan.id,
      inputHash: prepared.inputHash,
      promptVersion: agent.promptVersion,
      modelConfig: agent.modelConfig,
    };
    const logicalRunKey = `${ONBOARDING_PLAN_AGENT_NAME}:${createHash("sha256").update(canonicalJson(keyMaterial)).digest("hex")}`;

    // 2. Claim the logical run (or replay / refuse).
    const token = randomUUID();
    const claim = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(onboardingPlanRuns)
        .values({
          logicalRunKey,
          workflowId,
          provisioningPlanId: plan.id,
          sourceAgentRunId: plan.agentRunId,
          promptVersion: agent.promptVersion,
          modelProvider: agent.provider,
          model: agent.model,
          modelConfig: agent.modelConfig,
          catalogVersion: plan.catalogVersion,
          catalogHash: plan.catalogHash,
          policyVersion: plan.policyVersion,
          policyHash: plan.policyHash,
          inputHash: prepared.inputHash,
          inputSnapshot: prepared.modelInput as unknown as Record<string, unknown>,
          resourceSnapshot: ctx.resources as unknown as Record<string, unknown>[],
          status: "RUNNING",
          ownerToken: token,
          ownerId,
          ownerExpiresAt: plusMs(leaseMs) as unknown as Date,
          startedAt: clock as unknown as Date,
        })
        .onConflictDoNothing({ target: onboardingPlanRuns.logicalRunKey })
        .returning();
      if (inserted) return { kind: "claimed" as const, run: inserted };
      const [row] = await tx
        .select()
        .from(onboardingPlanRuns)
        .where(eq(onboardingPlanRuns.logicalRunKey, logicalRunKey))
        .for("update");
      if (!row) throw new Error("onboarding plan run vanished during claim");
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
        attempts: sql`${onboardingPlanRuns.attempts} + 1`,
        startedAt: clock,
        completedAt: null,
        latencyMs: null,
        modelCalls: null,
        servedModel: null,
        providerResponseId: null,
        inputTokens: null,
        outputTokens: null,
        errorCategory: null,
        errorMessage: null,
        errorRetryable: null,
        errorDetail: null,
        updatedAt: clock,
      };
      const [reclaimed] = await tx
        .update(onboardingPlanRuns)
        .set(reset as never)
        .where(eq(onboardingPlanRuns.id, row.id))
        .returning();
      return { kind: "claimed" as const, run: reclaimed! };
    });

    if (claim.kind === "replay") {
      const accepted = await acceptedPlanRow(workflowId);
      logOutcome(claim.run, { outcome: "REPLAYED" }, "onboarding plan run replayed");
      return {
        outcome: "ALREADY_COMPLETED" as const,
        workflowId,
        workflowState: await workflowState(workflowId),
        onboardingPlanId: accepted?.id ?? null,
        onboardingPlanRunId: claim.run.id,
        modelCalls: 0,
      };
    }
    if (claim.kind === "failed") {
      throw new OnboardingPlanError(
        "RUN_FAILED",
        `onboarding plan run failed permanently (${claim.run.errorCategory})`,
        { runId: claim.run.id, category: claim.run.errorCategory ?? undefined },
      );
    }
    if (claim.kind === "busy") {
      throw new OnboardingPlanError("BUSY", "another invocation is generating this plan", {
        retryable: true,
        runId: claim.run.id,
      });
    }
    const run = claim.run;
    await audit(
      workflowId,
      "onboarding_plan.generation_started",
      `onboarding-plan-run:${run.id}:started:${run.attempts}`,
      {
        onboardingPlanRunId: run.id,
        provisioningPlanId: plan.id,
        promptVersion: agent.promptVersion,
        attempt: run.attempts,
        settledResources: ctx.resources.length,
      },
    );

    // 3. Model call outside any transaction, bounded by the lease.
    const started = performance.now();
    const markFailed = async (
      category: string,
      message: string,
      retryable: boolean,
      detail: Record<string, unknown>,
    ) => {
      // Fenced: a stale owner records nothing (neither the failure nor its audit event).
      const updated = await db
        .update(onboardingPlanRuns)
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
        .where(fence(run.id, token))
        .returning({ id: onboardingPlanRuns.id });
      if (updated.length === 0) return;
      await audit(
        workflowId,
        "onboarding_plan.generation_failed",
        `onboarding-plan-run:${run.id}:failed:${run.attempts}`,
        {
          onboardingPlanRunId: run.id,
          category,
          retryable,
          attempt: run.attempts,
        },
      );
      logOutcome(run, { outcome: category, retryable }, "onboarding plan run failed");
    };

    let outcome: OnboardingPlanAgentResult;
    try {
      outcome = await withSpan(
        "agent.onboarding_plan.generate",
        {
          agentName: ONBOARDING_PLAN_AGENT_NAME,
          onboardingPlanRunId: run.id,
          provisioningPlanId: plan.id,
          workflowId,
        },
        () =>
          agent.generate(agentInput, {
            signal: AbortSignal.timeout(Math.floor(leaseMs * DEADLINE_FRACTION)),
          }),
      );
    } catch (err) {
      const agentError =
        err instanceof OnboardingPlanAgentError
          ? err
          : new OnboardingPlanAgentError(
              "NETWORK",
              sanitizeProviderText(String((err as Error)?.message ?? err)),
            );
      await markFailed(agentError.category, agentError.message, agentError.retryable, {
        modelCalls: agentError.attempts,
        ...(agentError.httpStatus !== undefined && { httpStatus: agentError.httpStatus }),
        ...(agentError.violations && {
          violations: agentError.violations.map((v) => ({
            code: v.code,
            ...(v.resourceIds && { resourceIds: v.resourceIds.slice(0, 20) }),
          })),
        }),
        ...(agentError.fields && { fields: agentError.fields.slice(0, 10) }),
        ...(agentError.usage && {
          inputTokens: agentError.usage.inputTokens,
          outputTokens: agentError.usage.outputTokens,
        }),
      });
      throw new OnboardingPlanError(
        "RUN_FAILED",
        `onboarding plan run failed: ${agentError.category}`,
        {
          retryable: agentError.retryable,
          runId: run.id,
          category: agentError.category,
        },
      );
    }

    // 4. Persist the accepted plan, the run's success and ONBOARDING_GENERATION → COMPLETED in
    //    one transaction: a COMPLETED workflow always has an accepted plan.
    for (let attempt = 0; attempt < 5; attempt++) {
      const details = await workflows.getWorkflow(workflowId);
      if (!details || details.workflow.state !== "ONBOARDING_GENERATION") {
        const accepted = await acceptedPlanRow(workflowId);
        await markFailed("WORKFLOW_NOT_ACTIVE", "workflow left ONBOARDING_GENERATION", false, {});
        if (accepted) {
          return {
            outcome: "ALREADY_COMPLETED" as const,
            workflowId,
            workflowState: details?.workflow.state ?? null,
            onboardingPlanId: accepted.id,
            onboardingPlanRunId: accepted.onboardingPlanRunId,
            modelCalls: outcome.attempts,
          };
        }
        throw new OnboardingPlanError(
          "RUN_FAILED",
          "workflow is no longer in ONBOARDING_GENERATION",
          {
            runId: run.id,
            category: "WORKFLOW_NOT_ACTIVE",
          },
        );
      }
      let planId: string | null = null;
      try {
        await workflows.transition(
          {
            workflowId,
            to: "COMPLETED",
            expectedVersion: details.workflow.version,
            actor: ONBOARDING_PLAN_ACTOR,
            correlationId: `onboarding-plan:${workflowId}`,
            idempotencyKey: `onboarding-plan-complete:${workflowId}`,
          },
          {
            effects: async (tx) => {
              const [done] = await tx
                .update(onboardingPlanRuns)
                .set({
                  status: "SUCCEEDED",
                  ...releaseOwner,
                  completedAt: clock,
                  latencyMs: outcome.latencyMs,
                  modelCalls: outcome.attempts,
                  servedModel: outcome.servedModel ?? null,
                  providerResponseId: outcome.responseId ?? null,
                  inputTokens: outcome.usage?.inputTokens ?? null,
                  outputTokens: outcome.usage?.outputTokens ?? null,
                  output: outcome.plan as unknown as Record<string, unknown>,
                  updatedAt: clock,
                } as never)
                .where(fence(run.id, token))
                .returning({ id: onboardingPlanRuns.id });
              if (!done) {
                throw new OnboardingPlanError(
                  "OWNERSHIP_LOST",
                  "lease on the onboarding plan run expired or was taken over; result discarded",
                  { retryable: true, runId: run.id },
                );
              }
              const [inserted] = await tx
                .insert(onboardingPlans)
                .values({
                  workflowId,
                  onboardingPlanRunId: run.id,
                  provisioningPlanId: plan.id,
                  promptVersion: agent.promptVersion,
                  summary: outcome.plan.summary,
                  tasks: outcome.plan.tasks as unknown as Record<string, unknown>[],
                  taskCount: outcome.plan.tasks.length,
                })
                .returning({ id: onboardingPlans.id });
              planId = inserted!.id;
              await tx.insert(auditEvents).values({
                workflowId,
                eventType: "onboarding_plan.generated",
                actor: ONBOARDING_PLAN_ACTOR,
                correlationId: `onboarding-plan:${workflowId}`,
                idempotencyKey: `onboarding-plan:${workflowId}:generated`,
                payload: {
                  onboardingPlanId: planId,
                  onboardingPlanRunId: run.id,
                  provisioningPlanId: plan.id,
                  sourceAgentRunId: plan.agentRunId,
                  promptVersion: agent.promptVersion,
                  servedModel: outcome.servedModel ?? null,
                  catalogVersion: plan.catalogVersion,
                  catalogHash: plan.catalogHash,
                  policyVersion: plan.policyVersion,
                  policyHash: plan.policyHash,
                  taskCount: outcome.plan.tasks.length,
                  referencedResourceIds: [
                    ...new Set(outcome.plan.tasks.flatMap((t) => t.resourceIds)),
                  ].sort(),
                },
              });
            },
          },
        );
      } catch (err) {
        if (err instanceof WorkflowVersionConflictError) continue;
        if (err instanceof InvalidTransitionError) continue; // re-read: the state changed
        if (err instanceof OnboardingPlanError) throw err;
        await markFailed(
          "PERSISTENCE",
          `persisting the onboarding plan failed: ${(err as Error).message}`,
          true,
          {},
        ).catch(() => {});
        throw new OnboardingPlanError("RUN_FAILED", "persisting the onboarding plan failed", {
          retryable: true,
          runId: run.id,
          category: "PERSISTENCE",
        });
      }
      if (planId === null) {
        // The completion key was already used: another run's plan is accepted. Ours is discarded.
        await markFailed("SUPERSEDED", "another run's plan was already accepted", false, {});
        const accepted = await acceptedPlanRow(workflowId);
        return {
          outcome: "ALREADY_COMPLETED" as const,
          workflowId,
          workflowState: await workflowState(workflowId),
          onboardingPlanId: accepted?.id ?? null,
          onboardingPlanRunId: accepted?.onboardingPlanRunId ?? null,
          modelCalls: outcome.attempts,
        };
      }
      logOutcome(
        run,
        {
          outcome: "SUCCEEDED",
          onboardingPlanId: planId,
          latencyMs: outcome.latencyMs,
          modelCalls: outcome.attempts,
          taskCount: outcome.plan.tasks.length,
        },
        "onboarding plan generated; workflow completed",
      );
      return {
        outcome: "COMPLETED" as const,
        workflowId,
        workflowState: "COMPLETED",
        onboardingPlanId: planId,
        onboardingPlanRunId: run.id,
        modelCalls: outcome.attempts,
      };
    }
    // Still RUNNING under our lease: release it so a retry can reclaim and replay.
    await markFailed("WORKFLOW_CONFLICT", "concurrent workflow changes kept conflicting", true, {});
    throw new OnboardingPlanError(
      "WORKFLOW_CONFLICT",
      "concurrent workflow changes kept conflicting",
      {
        retryable: true,
        runId: run.id,
      },
    );
  }

  async function getAcceptedPlan(workflowId: string): Promise<AcceptedOnboardingPlan | null> {
    const [row] = await db
      .select({ plan: onboardingPlans, run: onboardingPlanRuns })
      .from(onboardingPlans)
      .innerJoin(onboardingPlanRuns, eq(onboardingPlanRuns.id, onboardingPlans.onboardingPlanRunId))
      .where(eq(onboardingPlans.workflowId, workflowId));
    if (!row) return null;
    return Object.freeze({
      onboardingPlanId: row.plan.id,
      workflowId: row.plan.workflowId,
      onboardingPlanRunId: row.run.id,
      provisioningPlanId: row.plan.provisioningPlanId,
      sourceAgentRunId: row.run.sourceAgentRunId,
      promptVersion: row.plan.promptVersion,
      servedModel: row.run.servedModel,
      catalogVersion: row.run.catalogVersion,
      catalogHash: row.run.catalogHash,
      policyVersion: row.run.policyVersion,
      policyHash: row.run.policyHash,
      summary: row.plan.summary,
      tasks: row.plan.tasks,
      createdAt: row.plan.createdAt,
    });
  }

  async function enqueueDueGenerations({ limit = 100 }: { limit?: number } = {}) {
    const bucket = Math.floor(Date.now() / sweepIntervalMs);
    const due = await db
      .select({ id: onboardingWorkflows.id })
      .from(onboardingWorkflows)
      .where(
        and(
          eq(onboardingWorkflows.state, "ONBOARDING_GENERATION"),
          sql`NOT EXISTS (SELECT 1 FROM ${onboardingPlans} WHERE ${onboardingPlans.workflowId} = ${onboardingWorkflows.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.workflowId} = ${onboardingWorkflows.id} AND ${auditEvents.eventType} = 'onboarding_plan.generation_blocked')`,
          sql`NOT EXISTS (SELECT 1 FROM ${onboardingPlanRuns} WHERE ${onboardingPlanRuns.workflowId} = ${onboardingWorkflows.id} AND ${onboardingPlanRuns.status} = 'FAILED' AND ${onboardingPlanRuns.errorRetryable} = false)`,
        ),
      )
      .limit(limit);
    let enqueued = 0;
    for (const w of due) {
      if (
        await enqueueOnboardingPlanGeneration(db, {
          workflowId: w.id,
          reason: "SCHEDULED_RECOVERY",
          key: `sweep:${w.id}:${bucket}`,
        })
      ) {
        enqueued++;
      }
    }
    return { enqueued };
  }

  return { generatePlan, getAcceptedPlan, enqueueDueGenerations };
}
