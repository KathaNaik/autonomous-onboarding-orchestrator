import { createHash, randomUUID } from "node:crypto";
import {
  approvals,
  auditEvents,
  externalOperations,
  outboxEvents,
  type Database,
  type ExternalOperation,
  type Transaction,
} from "@aoo/db";
import {
  CreateAccessRequestInputSchema,
  POLICY_DECISIONS,
  ServiceNowAuthError,
  ServiceNowError,
  ServiceNowPermissionError,
  ServiceNowRequestError,
  ServiceNowUnavailableError,
  type AccessRequestRecord,
  type CreateAccessRequestInput,
  type ServiceNowClient,
} from "@aoo/servicenow";
import {
  ExternalOperationExecutePayloadSchema,
  OUTBOX_EVENT_TYPES,
  type ExternalOperationExecutePayload,
} from "@aoo/shared";
import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { noopLogger, type EventLogger } from "../events/types.js";
import { ExternalOperationError } from "./errors.js";
import { SERVICENOW_CREATE_ACCESS_REQUEST, serviceNowAccessRequestKeys } from "./keys.js";
import type { ExternalOperationHandler, HandlerProbe } from "./handler.js";
import {
  formatSanitizedError,
  sanitizeExternalError,
  scrubText,
  type SanitizedExternalError,
} from "./sanitize.js";

/** The ServiceNow calls the executor needs; satisfied by ServiceNowClient (and by test doubles). */
export type ServiceNowAccessRequestGateway = Pick<
  ServiceNowClient,
  "queryAccessRequests" | "getAccessRequest" | "createAccessRequest"
>;

export const RequestServiceNowAccessInputSchema = z.object({
  workflowId: z.uuid(),
  employeeId: z.string().trim().min(1).max(100),
  resourceId: z.string().trim().min(1).max(255),
  requestedEntitlement: z.string().trim().min(1).max(255),
  agentReason: z.string().trim().max(4000).default(""),
  policyDecision: z.enum(POLICY_DECISIONS),
  shortDescription: z.string().trim().min(1).max(160).optional(),
  actor: z.string().trim().min(1).max(200),
  /** M6B: ties the request (and its keys) to one authorization decision. */
  accessDecisionId: z.uuid().optional(),
});
export type RequestServiceNowAccessInput = z.input<typeof RequestServiceNowAccessInputSchema>;

export interface ExecutionSuccess {
  status: "SUCCEEDED";
  operationId: string;
  externalId: string;
  externalReference: string;
  /** created: this attempt POSTed; reconciled: found at the provider; already_succeeded: no call. */
  via: "created" | "reconciled" | "reconciled_after_unknown" | "already_succeeded";
}

export interface ExternalOperationServiceOptions {
  servicenow?: ServiceNowAccessRequestGateway;
  logger?: EventLogger;
  /** Bounded reconciliation after an uncertain write: queries by correlation key. */
  reconcile?: { attempts: number; delayMs: number };
  /** Provider-side correlation key prefix (tests use a distinct synthetic prefix). */
  correlationPrefix?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * M7A: provider handlers for non-ServiceNow operation types (e.g. Okta). They run on the same
   * durable executor as ServiceNow tickets.
   */
  handlers?: readonly ExternalOperationHandler[];
}

/** A provider-neutral durable operation to record (M7A). */
export interface RequestOperationInput {
  workflowId: string;
  provider: ExternalOperationHandler["provider"];
  operationType: string;
  /** Local logical identity: one row per logical operation, forever. */
  idempotencyKey: string;
  /** Provider-side identity (unique per provider). */
  correlationKey: string;
  request: Record<string, unknown>;
  actor: string;
  /** Emit an outbox execute event (worker-driven). Default true. */
  enqueueExecution?: boolean;
}

export interface ExternalOperationService {
  /**
   * Durably records a provider-neutral logical operation (idempotent by key; a reused key with a
   * different request throws IDEMPOTENCY_CONFLICT). Nothing is sent to the provider here.
   */
  requestOperation(input: RequestOperationInput): Promise<{
    operation: ExternalOperation;
    created: boolean;
  }>;
  /**
   * Durably records the logical operation (idempotent by logical key) and enqueues its
   * execution via the outbox, in one transaction. Nothing is sent to the provider here.
   */
  requestServiceNowAccessRequest(
    input: RequestServiceNowAccessInput,
  ): Promise<{ operation: ExternalOperation; created: boolean }>;
  /**
   * Executes or resumes one operation. Safe to call repeatedly and concurrently: at most one
   * caller owns the operation at a time, the provider is always reconciled by correlation key
   * before any create, and success requires provider read-back.
   * Throws ExternalOperationError (retryable or not) when it does not end in SUCCEEDED.
   */
  execute(
    operationId: string,
    owner: { ownerId: string; leaseMs: number },
  ): Promise<ExecutionSuccess>;
  get(operationId: string): Promise<ExternalOperation | null>;
  /** Manual: FAILED → PENDING and re-enqueue. CONFLICT is never reopened automatically. */
  reopen(
    operationId: string,
    params: { actor: string; reason: string },
  ): Promise<ExternalOperation>;
}

const clock = sql`clock_timestamp()`;
const plusMs = (ms: number) => sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;
/** Fraction of the lease the executor may spend on provider calls; the rest is safety margin. */
const DEADLINE_FRACTION = 0.8;

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type OperationInsert = typeof externalOperations.$inferInsert;
/** Column updates; values may be SQL expressions such as clock_timestamp(). */
type OperationUpdate = { [K in keyof OperationInsert]?: OperationInsert[K] | SQL };

/** Fields that must match between our request and the provider record. */
const VERIFIED_FIELDS = [
  ["correlationKey", "correlationKey"],
  ["employeeId", "employeeId"],
  ["workflowId", "workflowId"],
  ["resourceId", "resourceId"],
  ["requestedEntitlement", "requestedEntitlement"],
  ["policyDecision", "policyDecision"],
  ["agentReason", "agentReason"],
] as const;

type ParsedRequest = z.output<typeof CreateAccessRequestInputSchema>;

function mismatchedFields(record: AccessRequestRecord, request: ParsedRequest): string[] {
  return VERIFIED_FIELDS.filter(([r, q]) => (record[r] ?? "") !== (request[q] ?? "")).map(
    ([r]) => r,
  );
}

export function createExternalOperationService(
  db: Database,
  options: ExternalOperationServiceOptions = {},
): ExternalOperationService {
  const logger = options.logger ?? noopLogger;
  const reconcileCfg = options.reconcile ?? { attempts: 3, delayMs: 1000 };
  const sleep = options.sleep ?? abortableSleep;
  const handlers = new Map((options.handlers ?? []).map((h) => [h.operationType, h] as const));

  const get = async (id: string) =>
    (await db.select().from(externalOperations).where(eq(externalOperations.id, id)))[0] ?? null;

  function sensitiveValuesOf(request: ParsedRequest): string[] {
    return [request.employeeId, request.agentReason, request.shortDescription, request.resourceId];
  }

  /** Everything after claiming goes through fenced writes. */
  /** Ownership of a claimed operation; every write after the claim is fenced by it. */
  interface BaseFence {
    id: string;
    ownerToken: string;
    ownerId: string;
    workflowId: string;
  }
  interface Fence extends BaseFence {
    request: ParsedRequest;
  }

  const holdsFence = (f: BaseFence) =>
    and(
      eq(externalOperations.id, f.id),
      eq(externalOperations.ownerToken, f.ownerToken),
      gt(externalOperations.ownerExpiresAt, clock),
      inArray(externalOperations.status, ["IN_PROGRESS", "OUTCOME_UNKNOWN"]),
    );

  function ownershipLost(f: BaseFence): ExternalOperationError {
    return new ExternalOperationError(
      "OWNERSHIP_LOST",
      "OWNERSHIP",
      true,
      "lease on the operation expired or was taken over; result discarded",
      f.id,
    );
  }

  /** Fenced update. Throws OWNERSHIP_LOST if the caller no longer owns a live operation. */
  async function fenced(
    f: BaseFence,
    set: OperationUpdate,
    audit?: {
      eventType: string;
      payload: Record<string, unknown>;
    },
    within?: (tx: Transaction, row: ExternalOperation) => Promise<void>,
  ): Promise<ExternalOperation> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(externalOperations)
        .set({ ...set, updatedAt: clock })
        .where(holdsFence(f))
        .returning();
      if (!row) throw ownershipLost(f);
      if (within) await within(tx, row);
      if (audit) {
        await tx.insert(auditEvents).values({
          workflowId: f.workflowId,
          eventType: audit.eventType,
          actor: f.ownerId,
          correlationId: row.correlationKey,
          payload: {
            operationId: row.id,
            provider: row.provider,
            operationType: row.operationType,
            ...audit.payload,
          },
        });
      }
      return row;
    });
  }

  const releaseOwner = { ownerToken: null, ownerId: null, ownerExpiresAt: null } as const;

  async function release(
    f: BaseFence,
    status: "PENDING" | "OUTCOME_UNKNOWN",
    error: SanitizedExternalError,
  ): Promise<never> {
    await fenced(f, {
      ...releaseOwner,
      status,
      lastError: formatSanitizedError(error),
      lastErrorDetail: { ...error },
    });
    logger.warn({ operationId: f.id, status, error }, "external operation released for retry");
    throw new ExternalOperationError(
      "RETRY_LATER",
      error.category,
      true,
      formatSanitizedError(error),
      f.id,
    );
  }

  async function stop(
    f: BaseFence,
    status: "FAILED" | "CONFLICT",
    error: SanitizedExternalError,
    evidence?: Record<string, unknown>,
  ): Promise<never> {
    await fenced(
      f,
      {
        ...releaseOwner,
        status,
        lastError: formatSanitizedError(error),
        lastErrorDetail: { ...error },
        ...(evidence && { evidence }),
        completedAt: clock,
      },
      {
        eventType: `external_operation.${status.toLowerCase()}`,
        payload: { code: error.code, category: error.category },
      },
    );
    logger.error({ operationId: f.id, status, error }, "external operation stopped");
    throw new ExternalOperationError(
      status === "CONFLICT" ? "CONFLICT" : "FAILED",
      error.category,
      false,
      formatSanitizedError(error),
      f.id,
    );
  }

  function conflictError(f: Fence, message: string): SanitizedExternalError {
    return {
      provider: "servicenow",
      category: "CONFLICT",
      code: "PROVIDER_STATE_CONFLICT",
      correlationKey: f.request.correlationKey,
      retryable: false,
      message,
    };
  }

  /** Accept provider records as the outcome, after verification. */
  async function settle(
    f: Fence,
    records: AccessRequestRecord[],
    via: ExecutionSuccess["via"],
  ): Promise<ExecutionSuccess> {
    if (records.length > 1) {
      return stop(
        f,
        "CONFLICT",
        conflictError(f, `${records.length} provider records share the correlation key`),
        {
          records: records.map((r) => ({ sysId: r.sysId, number: r.number })),
        },
      );
    }
    const record = records[0]!;
    const mismatches = mismatchedFields(record, f.request);
    if (mismatches.length > 0) {
      return stop(
        f,
        "CONFLICT",
        conflictError(f, `provider record differs from the request in: ${mismatches.join(", ")}`),
        // Field names only: never copy provider/employee values into evidence.
        { records: [{ sysId: record.sysId, number: record.number }], mismatchedFields: mismatches },
      );
    }
    try {
      await fenced(
        f,
        {
          ...releaseOwner,
          status: "SUCCEEDED",
          externalId: record.sysId,
          externalReference: record.number,
          lastError: null,
          lastErrorDetail: null,
          completedAt: clock,
        },
        {
          eventType: "external_operation.succeeded",
          payload: { externalId: record.sysId, externalReference: record.number, via },
        },
        // A request that needs human approval gets its PENDING approval in the same transaction
        // that records the verified ticket, so an approval never exists without its ticket.
        async (tx, row) => {
          if (f.request.approvalState !== "pending") return;
          await tx
            .insert(approvals)
            .values({
              workflowId: row.workflowId,
              externalOperationId: row.id,
              provider: row.provider,
              correlationKey: row.correlationKey,
              externalId: record.sysId,
              externalReference: record.number,
              providerState: record.approvalState ?? null,
            })
            .onConflictDoNothing({ target: approvals.externalOperationId });
        },
      );
    } catch (err) {
      // A competing owner may have already recorded the same verified outcome.
      const current = await get(f.id);
      if (current?.status === "SUCCEEDED" && current.externalId === record.sysId) {
        return {
          status: "SUCCEEDED",
          operationId: f.id,
          externalId: record.sysId,
          externalReference: record.number,
          via,
        };
      }
      throw err;
    }
    logger.info(
      { operationId: f.id, externalReference: record.number, via },
      "external operation succeeded",
    );
    return {
      status: "SUCCEEDED",
      operationId: f.id,
      externalId: record.sysId,
      externalReference: record.number,
      via,
    };
  }

  async function lookup(gw: ServiceNowAccessRequestGateway, f: Fence, signal: AbortSignal) {
    return gw.queryAccessRequests(
      { correlationKey: f.request.correlationKey, limit: 2 },
      { signal },
    );
  }

  /** Bounded reconciliation by correlation key; returns as soon as the record is visible. */
  async function reconcile(gw: ServiceNowAccessRequestGateway, f: Fence, signal: AbortSignal) {
    for (let i = 1; i <= reconcileCfg.attempts; i++) {
      const found = await lookup(gw, f, signal);
      if (found.length > 0) return found;
      if (i < reconcileCfg.attempts) await sleep(reconcileCfg.delayMs, signal);
      if (signal.aborted) break;
    }
    return [];
  }

  /** Records the logical operation (+ outbox execute event + audit) in one transaction. */
  async function enqueue(
    input: RequestOperationInput,
  ): Promise<{ operation: ExternalOperation; created: boolean }> {
    const requestSha256 = sha256(input.request);
    return db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(externalOperations)
        .values({
          workflowId: input.workflowId,
          provider: input.provider,
          operationType: input.operationType,
          idempotencyKey: input.idempotencyKey,
          correlationKey: input.correlationKey,
          request: input.request,
          requestSha256,
        })
        .onConflictDoNothing({ target: externalOperations.idempotencyKey })
        .returning();

      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(externalOperations)
          .where(eq(externalOperations.idempotencyKey, input.idempotencyKey));
        if (existing!.requestSha256 !== requestSha256) {
          throw new ExternalOperationError(
            "IDEMPOTENCY_CONFLICT",
            "CONFLICT",
            false,
            "this logical operation already exists with different details",
            existing!.id,
          );
        }
        return { operation: existing!, created: false };
      }

      if (input.enqueueExecution !== false) {
        const payload: ExternalOperationExecutePayload =
          ExternalOperationExecutePayloadSchema.parse({
            operationId: inserted.id,
            provider: inserted.provider,
            operationType: inserted.operationType,
          });
        await tx.insert(outboxEvents).values({
          idempotencyKey: `${OUTBOX_EVENT_TYPES.externalOperationExecute}:${inserted.id}`,
          aggregateType: "onboarding_workflow",
          aggregateId: input.workflowId,
          eventType: OUTBOX_EVENT_TYPES.externalOperationExecute,
          payload,
          correlationId: inserted.correlationKey,
        });
      }
      await tx.insert(auditEvents).values({
        workflowId: input.workflowId,
        eventType: "external_operation.requested",
        actor: input.actor,
        correlationId: inserted.correlationKey,
        payload: {
          operationId: inserted.id,
          provider: inserted.provider,
          operationType: inserted.operationType,
        },
      });
      return { operation: inserted, created: true };
    });
  }

  /**
   * Generic durable execution for handler-based operations (M7A). Same guarantees as the
   * ServiceNow path: reconcile before any write, one write per attempt, OUTCOME_UNKNOWN persisted
   * before reconciling an uncertain write, verified read-back before SUCCEEDED, fenced writes.
   */
  async function executeWithHandler(
    handler: ExternalOperationHandler,
    row: ExternalOperation,
    previousStatus: string | null,
    ownerId: string,
    leaseMs: number,
  ): Promise<ExecutionSuccess> {
    const f: BaseFence = {
      id: row.id,
      ownerToken: row.ownerToken!,
      ownerId,
      workflowId: row.workflowId,
    };
    const provider = handler.provider;
    let request: unknown;
    try {
      request = handler.parseRequest(row.request);
    } catch {
      return stop(f, "FAILED", {
        provider,
        category: "VALIDATION",
        code: "REQUEST_INVALID",
        correlationKey: row.correlationKey,
        retryable: false,
        message: "stored request does not match the operation type",
      });
    }
    const maybeSentBefore = previousStatus !== "PENDING";
    const deadline = AbortSignal.timeout(Math.max(1, Math.floor(leaseMs * DEADLINE_FRACTION)));
    const ctx = { signal: deadline };
    const sanitize = (err: unknown) =>
      sanitizeExternalError(err, {
        provider,
        correlationKey: row.correlationKey,
        sensitiveValues: handler.sensitiveValues(request),
      });
    const conflict = (p: Extract<HandlerProbe, { kind: "conflict" }>) =>
      stop(
        f,
        "CONFLICT",
        {
          provider,
          category: "CONFLICT",
          code: p.code,
          correlationKey: row.correlationKey,
          retryable: false,
          message: scrubText(p.message, handler.sensitiveValues(request)),
        },
        { code: p.code, ...(p.evidence ?? {}) },
      );
    const succeed = async (
      p: Extract<HandlerProbe, { kind: "satisfied" }>,
      via: ExecutionSuccess["via"],
    ): Promise<ExecutionSuccess> => {
      try {
        await fenced(
          f,
          {
            ...releaseOwner,
            status: "SUCCEEDED",
            externalId: p.externalId,
            externalReference: p.externalReference,
            lastError: null,
            lastErrorDetail: null,
            completedAt: clock,
          },
          {
            eventType: "external_operation.succeeded",
            payload: { externalId: p.externalId, externalReference: p.externalReference, via },
          },
        );
      } catch (err) {
        const current = await get(f.id);
        if (current?.status !== "SUCCEEDED" || current.externalId !== p.externalId) throw err;
      }
      logger.info(
        { operationId: f.id, provider, operationType: handler.operationType, via },
        "external operation succeeded",
      );
      return {
        status: "SUCCEEDED",
        operationId: f.id,
        externalId: p.externalId,
        externalReference: p.externalReference,
        via,
      };
    };

    let sent = false;
    try {
      // 1. Reconcile first, always.
      const existing = await handler.reconcile(request, ctx);
      if (existing.kind === "satisfied") {
        return await succeed(existing, maybeSentBefore ? "reconciled_after_unknown" : "reconciled");
      }
      if (existing.kind === "conflict") return await conflict(existing);

      // 2. One write per attempt.
      let performed: unknown;
      try {
        sent = true;
        performed = await handler.perform(request, ctx);
      } catch (err) {
        const cls = handler.classify(err);
        const error = sanitize(err);
        if (cls === "failed") return await stop(f, "FAILED", error);
        if (cls === "not_sent") {
          sent = false;
          return await release(f, maybeSentBefore ? "OUTCOME_UNKNOWN" : "PENDING", error);
        }
        // The write may have taken effect: record that BEFORE anything else, then reconcile.
        await fenced(f, {
          status: "OUTCOME_UNKNOWN",
          lastError: formatSanitizedError(error),
          lastErrorDetail: { ...error },
        });
        logger.warn(
          { operationId: f.id, provider, error },
          "external write outcome unknown; reconciling",
        );
        for (let i = 1; i <= reconcileCfg.attempts; i++) {
          const probe = await handler.reconcile(request, ctx);
          if (probe.kind === "satisfied") return await succeed(probe, "reconciled_after_unknown");
          if (probe.kind === "conflict") return await conflict(probe);
          if (i < reconcileCfg.attempts) await sleep(reconcileCfg.delayMs, deadline);
          if (deadline.aborted) break;
        }
        return await release(f, "OUTCOME_UNKNOWN", error);
      }

      // 3. Success only after authoritative read-back.
      const verified = await handler.verify(request, performed, ctx);
      if (verified.kind === "satisfied") return await succeed(verified, "created");
      if (verified.kind === "conflict") return await conflict(verified);
      return await release(f, "OUTCOME_UNKNOWN", {
        provider,
        category: "RESPONSE_INVALID",
        code: "READ_BACK_MISSING",
        correlationKey: row.correlationKey,
        retryable: true,
        message: "write succeeded but the provider read-back did not confirm it",
      });
    } catch (err) {
      if (err instanceof ExternalOperationError) throw err;
      if (handler.classify(err) === "failed") return await stop(f, "FAILED", sanitize(err));
      return await release(
        f,
        sent || maybeSentBefore ? "OUTCOME_UNKNOWN" : "PENDING",
        sanitize(err),
      );
    }
  }

  async function claim(id: string, ownerId: string, leaseMs: number) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(externalOperations)
        .where(eq(externalOperations.id, id))
        .for("update");
      if (!row) return { row: null, previousStatus: null, claimed: false as const };
      const [{ now }] = (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`))
        .rows as [{ now: Date }];
      const ownerLive = row.ownerExpiresAt !== null && row.ownerExpiresAt > new Date(now);
      const claimable =
        row.status === "PENDING" ||
        ((row.status === "IN_PROGRESS" || row.status === "OUTCOME_UNKNOWN") && !ownerLive);
      if (!claimable) return { row, previousStatus: row.status, claimed: false as const };
      const [claimed] = await tx
        .update(externalOperations)
        .set({
          status: "IN_PROGRESS",
          ownerToken: randomUUID(),
          ownerId,
          ownerExpiresAt: plusMs(leaseMs),
          attempts: sql`${externalOperations.attempts} + 1`,
          updatedAt: clock,
        })
        .where(eq(externalOperations.id, id))
        .returning();
      return { row: claimed!, previousStatus: row.status, claimed: true as const };
    });
  }

  return {
    async requestServiceNowAccessRequest(rawInput) {
      const input = RequestServiceNowAccessInputSchema.parse(rawInput);
      const keys = serviceNowAccessRequestKeys(input, options.correlationPrefix);
      const request: CreateAccessRequestInput = CreateAccessRequestInputSchema.parse({
        shortDescription:
          input.shortDescription ??
          `Onboarding access: ${input.requestedEntitlement} on ${input.resourceId}`,
        employeeId: input.employeeId,
        workflowId: input.workflowId,
        resourceId: input.resourceId,
        requestedEntitlement: input.requestedEntitlement,
        agentReason: input.agentReason,
        policyDecision: input.policyDecision,
        approvalState: input.policyDecision === "requires_approval" ? "pending" : "not_required",
        correlationKey: keys.correlationKey,
      });
      return enqueue({
        workflowId: input.workflowId,
        provider: "servicenow",
        operationType: SERVICENOW_CREATE_ACCESS_REQUEST,
        idempotencyKey: keys.idempotencyKey,
        correlationKey: keys.correlationKey,
        request: request as Record<string, unknown>,
        actor: input.actor,
      });
    },

    requestOperation: (input) => enqueue(input),

    async execute(operationId, { ownerId, leaseMs }) {
      const current = await get(operationId);
      if (!current) {
        throw new ExternalOperationError(
          "NOT_FOUND",
          "VALIDATION",
          false,
          "operation not found",
          operationId,
        );
      }
      if (current.status === "SUCCEEDED") {
        return {
          status: "SUCCEEDED",
          operationId,
          externalId: current.externalId!,
          externalReference: current.externalReference!,
          via: "already_succeeded",
        };
      }
      if (current.status === "FAILED" || current.status === "CONFLICT") {
        throw new ExternalOperationError(
          "STOPPED",
          current.status === "CONFLICT" ? "CONFLICT" : "VALIDATION",
          false,
          `operation is ${current.status}; reopen it after investigation`,
          operationId,
        );
      }

      const handler =
        current.operationType === SERVICENOW_CREATE_ACCESS_REQUEST
          ? undefined
          : handlers.get(current.operationType);
      const gw = options.servicenow;
      if (current.operationType === SERVICENOW_CREATE_ACCESS_REQUEST ? !gw : !handler) {
        throw new ExternalOperationError(
          "PROVIDER_NOT_CONFIGURED",
          "VALIDATION",
          false,
          `${current.provider} (${current.operationType}) is not configured on this process`,
          operationId,
        );
      }

      const claimed = await claim(operationId, ownerId, leaseMs);
      if (!claimed.claimed) {
        if (claimed.row?.status === "SUCCEEDED") {
          return {
            status: "SUCCEEDED",
            operationId,
            externalId: claimed.row.externalId!,
            externalReference: claimed.row.externalReference!,
            via: "already_succeeded",
          };
        }
        throw new ExternalOperationError(
          "BUSY",
          "OWNERSHIP",
          true,
          `operation is ${claimed.row?.status ?? "missing"} and owned by another worker`,
          operationId,
        );
      }

      const row = claimed.row;
      if (handler) {
        return executeWithHandler(handler, row, claimed.previousStatus, ownerId, leaseMs);
      }
      const request = CreateAccessRequestInputSchema.parse(row.request);
      const f: Fence = {
        id: row.id,
        ownerToken: row.ownerToken!,
        ownerId,
        workflowId: row.workflowId,
        request,
      };
      // A previous owner may have sent a create before dying: never resume as "certainly unsent".
      const maybeSentBefore = claimed.previousStatus !== "PENDING";
      const deadline = AbortSignal.timeout(Math.max(1, Math.floor(leaseMs * DEADLINE_FRACTION)));
      const sanitize = (err: unknown) =>
        sanitizeExternalError(err, {
          provider: "servicenow",
          correlationKey: request.correlationKey,
          sensitiveValues: sensitiveValuesOf(request),
        });

      let postSent = false;
      try {
        // 1. Reconcile first, always: the provider may already hold the record.
        const existing = await lookup(gw!, f, deadline);
        if (existing.length > 0)
          return await settle(
            f,
            existing,
            maybeSentBefore ? "reconciled_after_unknown" : "reconciled",
          );

        // 2. Create exactly once per attempt; the unique correlation_key is the provider's last guard.
        let created: AccessRequestRecord;
        try {
          postSent = true;
          created = await gw!.createAccessRequest(request, { signal: deadline });
        } catch (err) {
          const error = sanitize(err);
          if (err instanceof ServiceNowAuthError || err instanceof ServiceNowRequestError) {
            return await stop(f, "FAILED", error);
          }
          if (err instanceof ServiceNowUnavailableError && err.notSent) {
            postSent = false;
            return await release(f, maybeSentBefore ? "OUTCOME_UNKNOWN" : "PENDING", error);
          }
          // Uncertain (timeout, dropped connection, 5xx, unreadable 2xx) or rejected (400/403,
          // possibly a unique-key violation). Record the uncertainty BEFORE doing anything else.
          await fenced(f, {
            status: "OUTCOME_UNKNOWN",
            lastError: formatSanitizedError(error),
            lastErrorDetail: { ...error },
          });
          logger.warn({ operationId: f.id, error }, "external write outcome unknown; reconciling");
          const found = await reconcile(gw!, f, deadline);
          if (found.length > 0) return await settle(f, found, "reconciled_after_unknown");
          if (
            err instanceof ServiceNowPermissionError ||
            (err instanceof ServiceNowError && err.code === "BAD_REQUEST")
          ) {
            return await stop(f, "FAILED", error);
          }
          return await release(f, "OUTCOME_UNKNOWN", error);
        }

        // 3. Record the provider ids immediately, then verify by read-back.
        await fenced(f, { externalId: created.sysId, externalReference: created.number });
        const readBack = await gw!.getAccessRequest(created.sysId, { signal: deadline });
        if (!readBack) {
          return await release(f, "OUTCOME_UNKNOWN", {
            provider: "servicenow",
            category: "RESPONSE_INVALID",
            code: "READ_BACK_MISSING",
            correlationKey: request.correlationKey,
            retryable: true,
            message: "created record was not readable by sys_id",
          });
        }
        return await settle(f, [readBack], "created");
      } catch (err) {
        if (err instanceof ExternalOperationError) throw err;
        // Reconciliation/read-back infrastructure failure: keep the operation safe and retry later.
        return await release(
          f,
          postSent || maybeSentBefore ? "OUTCOME_UNKNOWN" : "PENDING",
          sanitize(err),
        );
      }
    },

    get,

    async reopen(operationId, { actor, reason }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(externalOperations)
          .set({ status: "PENDING", completedAt: null, updatedAt: clock })
          .where(
            and(eq(externalOperations.id, operationId), eq(externalOperations.status, "FAILED")),
          )
          .returning();
        if (!row) {
          throw new ExternalOperationError(
            "STOPPED",
            "VALIDATION",
            false,
            "only FAILED operations can be reopened",
            operationId,
          );
        }
        await tx.insert(outboxEvents).values({
          idempotencyKey: `${OUTBOX_EVENT_TYPES.externalOperationExecute}:${row.id}:reopen:${randomUUID()}`,
          aggregateType: "onboarding_workflow",
          aggregateId: row.workflowId,
          eventType: OUTBOX_EVENT_TYPES.externalOperationExecute,
          payload: {
            operationId: row.id,
            provider: row.provider,
            operationType: row.operationType,
          },
          correlationId: row.correlationKey,
        });
        await tx.insert(auditEvents).values({
          workflowId: row.workflowId,
          eventType: "external_operation.reopened",
          actor,
          correlationId: row.correlationKey,
          payload: { operationId: row.id, reason },
        });
        return row;
      });
    },
  };
}
