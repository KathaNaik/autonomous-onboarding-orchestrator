import { createHash } from "node:crypto";
import type { CatalogRegistry } from "@aoo/catalog";
import {
  accessRequests,
  auditEvents,
  externalOperations,
  workflowProvisioningPlans,
  type AccessRequest,
  type Database,
} from "@aoo/db";
import {
  ServiceNowError,
  ServiceNowOutcomeUnknownError,
  ServiceNowUnavailableError,
  type AccessRequestRecord,
  type ServiceNowClient,
} from "@aoo/servicenow";
import type { ServiceNowFulfillmentCallback } from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { noopLogger, type EventLogger } from "../events/types.js";
import { ExternalOperationError } from "../external-operations/errors.js";
import type {
  ExternalOperationHandler,
  FailureClass,
  HandlerProbe,
} from "../external-operations/handler.js";
import type { ExecutionSuccess, ExternalOperationService } from "../external-operations/service.js";
import {
  EligibilityError,
  loadAuthorizedRequest,
  resolveProviderResource,
  type EligibilityCode,
} from "./eligibility.js";
import { enqueueProvisioningWake } from "./wake.js";

// M7D: ServiceNow-backed human fulfillment. One dedicated fulfillment record per authorized
// SERVICENOW access request, separate from any M4B/M4C approval record. Creating the record is
// NOT provisioning: the resource becomes PROVISIONED only when a ServiceNow read-back says
// fulfillment_state = fulfilled.

export const SERVICENOW_CREATE_FULFILLMENT_REQUEST = "servicenow.create_fulfillment_request";
export const SERVICENOW_FULFILLMENT_ACTOR = "servicenow-fulfillment";
/** Provider-side prefix; distinct from approval tickets' "aoo-oar-" keys. */
export const DEFAULT_FULFILLMENT_CORRELATION_PREFIX = "aoo-ful-";

/** The ServiceNow calls fulfillment needs; satisfied by ServiceNowClient (and by test doubles). */
export type ServiceNowFulfillmentGateway = Pick<
  ServiceNowClient,
  "queryAccessRequests" | "getAccessRequest" | "createAccessRequest"
>;

/** One logical fulfillment operation per authorized access request (never shared with approval). */
export function serviceNowFulfillmentKeys(
  i: { accessDecisionId: string; accessRequestId: string; resourceId: string },
  prefix: string = DEFAULT_FULFILLMENT_CORRELATION_PREFIX,
) {
  const idempotencyKey = `${SERVICENOW_CREATE_FULFILLMENT_REQUEST}:decision=${i.accessDecisionId}:request=${i.accessRequestId}:resource=${i.resourceId}`;
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40);
  return { idempotencyKey, correlationKey: `${prefix}${digest}` };
}

const FulfillmentRequestSchema = z.strictObject({
  accessRequestId: z.uuid(),
  accessDecisionId: z.uuid(),
  workflowId: z.uuid(),
  /** HRIS employee id (what ServiceNow shows the fulfiller). */
  employeeId: z.string().min(1).max(100),
  resourceId: z.string().min(1).max(255),
  requestedEntitlement: z.string().min(1).max(255),
  policyDecision: z.enum(["allow", "requires_approval"]),
  agentReason: z.string().max(4000),
  shortDescription: z.string().min(1).max(160),
  correlationKey: z.string().min(8).max(255),
});
export type ServiceNowFulfillmentRequest = z.infer<typeof FulfillmentRequestSchema>;

/**
 * The fields a fulfillment record must carry. Returns mismatched field NAMES (never values);
 * empty means the record is exactly ours.
 */
export function fulfillmentRecordMismatches(
  record: AccessRequestRecord,
  r: Pick<
    ServiceNowFulfillmentRequest,
    "correlationKey" | "resourceId" | "workflowId" | "employeeId" | "requestedEntitlement"
  >,
): string[] {
  const expected: Array<[string, unknown, unknown]> = [
    ["request_kind", record.requestKind, "fulfillment"],
    ["correlation_key", record.correlationKey, r.correlationKey],
    ["resource_id", record.resourceId, r.resourceId],
    ["workflow_id", record.workflowId, r.workflowId],
    ["employee_id", record.employeeId, r.employeeId],
    ["requested_entitlement", record.requestedEntitlement, r.requestedEntitlement],
  ];
  return expected.filter(([, actual, want]) => actual !== want).map(([name]) => name);
}

function probeRecord(
  record: AccessRequestRecord | null,
  r: ServiceNowFulfillmentRequest,
): HandlerProbe {
  if (!record) return { kind: "absent" };
  const mismatched = fulfillmentRecordMismatches(record, r);
  if (mismatched.length > 0) {
    return {
      kind: "conflict",
      code: "FULFILLMENT_RECORD_MISMATCH",
      message: "the ServiceNow record doesn't match the fulfillment request",
      evidence: { sysId: record.sysId, number: record.number, mismatchedFields: mismatched },
    };
  }
  return { kind: "satisfied", externalId: record.sysId, externalReference: record.number };
}

/** Retryable: timeout, connection loss, 429, 5xx. Deterministic: auth, permission, bad input/shape. */
export function classifyServiceNowFulfillmentError(err: unknown): FailureClass {
  if (err instanceof ServiceNowUnavailableError) return err.notSent ? "not_sent" : "retry";
  if (err instanceof ServiceNowOutcomeUnknownError) return "outcome_unknown";
  if (err instanceof ServiceNowError) return err.retryable ? "retry" : "failed";
  return "retry";
}

export function createServiceNowFulfillmentHandler(
  sn: ServiceNowFulfillmentGateway,
): ExternalOperationHandler<ServiceNowFulfillmentRequest> {
  return {
    provider: "servicenow",
    operationType: SERVICENOW_CREATE_FULFILLMENT_REQUEST,
    parseRequest: (raw) => FulfillmentRequestSchema.parse(raw),
    sensitiveValues: (r) => [r.employeeId, r.agentReason, r.shortDescription],
    async reconcile(r, { signal }) {
      const found = await sn.queryAccessRequests(
        { correlationKey: r.correlationKey, limit: 5 },
        { signal },
      );
      if (found.length > 1) {
        return {
          kind: "conflict",
          code: "DUPLICATE_FULFILLMENT_RECORDS",
          message: "more than one ServiceNow record has this correlation key",
          evidence: { sysIds: found.map((f) => f.sysId), numbers: found.map((f) => f.number) },
        };
      }
      return probeRecord(found[0] ?? null, r);
    },
    // The single write: one fulfillment record, never an approval request.
    perform: (r, { signal }) =>
      sn.createAccessRequest(
        {
          shortDescription: r.shortDescription,
          employeeId: r.employeeId,
          workflowId: r.workflowId,
          resourceId: r.resourceId,
          requestedEntitlement: r.requestedEntitlement,
          agentReason: r.agentReason,
          policyDecision: r.policyDecision,
          approvalState: "not_required",
          requestKind: "fulfillment",
          fulfillmentState: "pending",
          correlationKey: r.correlationKey,
        },
        { signal },
      ),
    async verify(r, performed, { signal }) {
      const sysId = (performed as AccessRequestRecord).sysId;
      return probeRecord(await sn.getAccessRequest(sysId, { signal }), r);
    },
    classify: classifyServiceNowFulfillmentError,
  };
}

export type ServiceNowFulfillmentErrorCode =
  | EligibilityCode
  | "INVALID_INPUT"
  /** The request isn't part of the workflow's active provisioning plan (e.g. a historical run). */
  | "NOT_IN_ACTIVE_PLAN"
  | "DEPENDENCIES_NOT_READY"
  /** Terminal for the resource: PROVISIONING_FAILED (fulfiller reported failure, or a conflict). */
  | "PROVISIONING_FAILED"
  /** Transient: ServiceNow unavailable or another owner busy. Re-invoke later. */
  | "RETRY_LATER";

export class ServiceNowFulfillmentError extends Error {
  readonly retryable: boolean;
  readonly reason: string | undefined;
  constructor(
    readonly code: ServiceNowFulfillmentErrorCode,
    message: string,
    options: { retryable?: boolean; reason?: string } = {},
  ) {
    super(message);
    this.name = "ServiceNowFulfillmentError";
    this.retryable = options.retryable ?? false;
    this.reason = options.reason;
  }
}

export interface ServiceNowFulfillmentResult {
  accessRequestId: string;
  resourceId: string;
  /** PROVISIONED only after ServiceNow says fulfilled; otherwise the human work is outstanding. */
  status: "PROVISIONED" | "FULFILLMENT_PENDING" | "FULFILLMENT_IN_PROGRESS";
  replayed: boolean;
  sysId: string;
  number: string;
  operationId: string;
  fulfillmentState: string | null;
}

export interface ServiceNowFulfillmentService {
  /**
   * Handles exactly one authorized SERVICENOW access request: ensures its single fulfillment
   * record (durable, reconcile-before-create), then maps ServiceNow's authoritative
   * fulfillment_state to the local lifecycle. M7C decides when it runs.
   */
  provisionServiceNowAccess(input: {
    accessRequestId: string;
  }): Promise<ServiceNowFulfillmentResult>;
}

export interface ServiceNowFulfillmentServiceOptions {
  catalogs: CatalogRegistry;
  /** The durable executor, configured with createServiceNowFulfillmentHandler. */
  externalOperations: ExternalOperationService;
  /** Read access for the authoritative fulfillment-state read-back. */
  servicenow: Pick<ServiceNowFulfillmentGateway, "getAccessRequest">;
  /** Provider correlation prefix (live tests use a distinct synthetic prefix). */
  correlationPrefix?: string;
  ownerId?: string;
  leaseMs?: number;
  busyWaitMs?: number;
  logger?: EventLogger;
}

const InputSchema = z.strictObject({ accessRequestId: z.uuid() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createServiceNowFulfillmentService(
  db: Database,
  options: ServiceNowFulfillmentServiceOptions,
): ServiceNowFulfillmentService {
  const { catalogs, externalOperations: extOps } = options;
  const ownerId = options.ownerId ?? `servicenow-fulfillment-${process.pid}`;
  const leaseMs = options.leaseMs ?? 60_000;
  const busyWaitMs = options.busyWaitMs ?? 5_000;
  const logger = options.logger ?? noopLogger;
  const clock = sql`clock_timestamp()`;

  const audit = (
    request: AccessRequest,
    eventType: string,
    key: string,
    payload: Record<string, unknown>,
  ) => ({
    workflowId: request.workflowId,
    eventType,
    actor: SERVICENOW_FULFILLMENT_ACTOR,
    correlationId: `provisioning:${request.id}`,
    idempotencyKey: key,
    payload: {
      accessRequestId: request.id,
      accessDecisionId: request.accessDecisionId,
      resourceId: request.resourceId,
      provider: "SERVICENOW",
      ...payload,
    },
  });

  async function executeOrWait(operationId: string): Promise<ExecutionSuccess> {
    const started = Date.now();
    for (;;) {
      try {
        return await extOps.execute(operationId, { ownerId, leaseMs });
      } catch (err) {
        if (
          err instanceof ExternalOperationError &&
          err.code === "BUSY" &&
          Date.now() - started < busyWaitMs
        ) {
          await wait(100);
          continue;
        }
        throw err;
      }
    }
  }

  async function markFailed(
    request: AccessRequest,
    reason: string,
    context: Record<string, unknown>,
  ) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(accessRequests)
        .set({
          status: "PROVISIONING_FAILED",
          provisioningErrorCode: reason,
          providerState: null,
          version: sql`${accessRequests.version} + 1`,
          updatedAt: clock,
        })
        .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
        .returning();
      if (row) {
        await tx
          .insert(auditEvents)
          .values([
            audit(
              request,
              "servicenow.fulfillment_failed",
              `access-request:${request.id}:fulfillment-failed`,
              {
                reason,
                ...context,
              },
            ),
            audit(
              request,
              "resource.provisioning_failed",
              `access-request:${request.id}:provisioning-failed`,
              {
                reason,
                ...context,
              },
            ),
          ])
          .onConflictDoNothing();
      }
    });
  }

  function fail(reason: string): never {
    throw new ServiceNowFulfillmentError(
      "PROVISIONING_FAILED",
      `ServiceNow fulfillment stopped: ${reason}`,
      { reason },
    );
  }

  function evidenceOf(request: AccessRequest) {
    return (request.providerEvidence ?? {}) as {
      serviceNowSysId?: string;
      ticketNumber?: string;
      operationId?: string;
      correlationKey?: string;
      fulfillmentState?: string | null;
    };
  }

  async function provisionServiceNowAccess(input: {
    accessRequestId: string;
  }): Promise<ServiceNowFulfillmentResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ServiceNowFulfillmentError("INVALID_INPUT", "accessRequestId must be a UUID");
    }
    const { accessRequestId } = parsed.data;

    // 1. Authorization chain, exact catalog, provider SERVICENOW (fail closed; no ServiceNow call).
    let authorized;
    let resource;
    try {
      authorized = await loadAuthorizedRequest(db, accessRequestId);
      resource = resolveProviderResource(
        catalogs,
        authorized.decision,
        authorized.request,
        "SERVICENOW",
      );
    } catch (err) {
      if (err instanceof EligibilityError)
        throw new ServiceNowFulfillmentError(err.code, err.message);
      throw err;
    }
    const { request, decision, employee } = authorized;
    if (request.status === "MANUAL_ACTION_REQUIRED") {
      throw new ServiceNowFulfillmentError("NOT_ELIGIBLE", "not a ServiceNow fulfillment state");
    }

    // 2. Replay: PROVISIONED is final; no ServiceNow call.
    if (request.status === "PROVISIONED") {
      const ev = evidenceOf(request);
      return {
        accessRequestId,
        resourceId: request.resourceId,
        status: "PROVISIONED",
        replayed: true,
        sysId: ev.serviceNowSysId ?? request.providerTargetId ?? "",
        number: ev.ticketNumber ?? "",
        operationId: request.provisioningOperationId ?? ev.operationId ?? "",
        fulfillmentState: ev.fulfillmentState ?? "fulfilled",
      };
    }
    if (request.status === "PROVISIONING_FAILED") {
      fail(request.provisioningErrorCode ?? "PROVISIONING_FAILED");
    }

    // 3. M7C plan membership and plan-scoped dependencies (defense in depth).
    const [plan] = await db
      .select()
      .from(workflowProvisioningPlans)
      .where(
        and(
          eq(workflowProvisioningPlans.workflowId, request.workflowId),
          eq(workflowProvisioningPlans.agentRunId, request.agentRunId),
          eq(workflowProvisioningPlans.status, "ACTIVE"),
        ),
      );
    if (!plan) {
      throw new ServiceNowFulfillmentError(
        "NOT_IN_ACTIVE_PLAN",
        "the request isn't part of the workflow's active provisioning plan",
      );
    }
    for (const dep of resource.dependsOn) {
      const [ready] = await db
        .select({ id: accessRequests.id })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.workflowId, request.workflowId),
            eq(accessRequests.agentRunId, request.agentRunId),
            eq(accessRequests.resourceId, dep),
            eq(accessRequests.status, "PROVISIONED"),
          ),
        );
      if (!ready) {
        throw new ServiceNowFulfillmentError(
          "DEPENDENCIES_NOT_READY",
          `dependency ${dep} isn't PROVISIONED in this plan`,
        );
      }
    }

    // 4. Claim PROVISIONING (short transaction).
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(accessRequests)
        .set({
          status: "PROVISIONING",
          version: sql`${accessRequests.version} + 1`,
          updatedAt: clock,
        })
        .where(
          and(
            eq(accessRequests.id, request.id),
            eq(accessRequests.status, "READY_FOR_PROVISIONING"),
          ),
        )
        .returning();
      if (claimed) {
        await tx
          .insert(auditEvents)
          .values(
            audit(
              request,
              "resource.provisioning_started",
              `access-request:${request.id}:provisioning-started`,
              {},
            ),
          )
          .onConflictDoNothing();
      }
    });
    const current = { ...request, status: "PROVISIONING" as const };

    // 5. The single fulfillment record (durable: reconcile → create once → read back).
    const keys = serviceNowFulfillmentKeys(
      {
        accessDecisionId: decision.id,
        accessRequestId: request.id,
        resourceId: request.resourceId,
      },
      options.correlationPrefix,
    );
    let ticket: ExecutionSuccess;
    let operationId: string;
    try {
      const { operation } = await extOps.requestOperation({
        workflowId: request.workflowId,
        provider: "servicenow",
        operationType: SERVICENOW_CREATE_FULFILLMENT_REQUEST,
        ...keys,
        request: {
          accessRequestId: request.id,
          accessDecisionId: decision.id,
          workflowId: request.workflowId,
          employeeId: employee.hrisEmployeeId,
          resourceId: request.resourceId,
          requestedEntitlement: resource.displayName,
          policyDecision: decision.decision === "ALLOW" ? "allow" : "requires_approval",
          agentReason: `Authorized (${decision.reasonCode}); fulfill ${resource.displayName}.`,
          shortDescription:
            `AOO fulfillment: ${resource.displayName} (decision ${decision.id})`.slice(0, 160),
          correlationKey: keys.correlationKey,
        },
        actor: SERVICENOW_FULFILLMENT_ACTOR,
        enqueueExecution: false,
      });
      operationId = operation.id;
      ticket = await executeOrWait(operation.id);
    } catch (err) {
      if (err instanceof ExternalOperationError && err.retryable) {
        throw new ServiceNowFulfillmentError("RETRY_LATER", err.message, { retryable: true });
      }
      if (err instanceof ExternalOperationError) {
        let reason: string = err.code;
        if (err.operationId) {
          const [op] = await db
            .select({ detail: externalOperations.lastErrorDetail })
            .from(externalOperations)
            .where(eq(externalOperations.id, err.operationId));
          const code = (op?.detail as { code?: unknown } | null)?.code;
          if (typeof code === "string") reason = code;
        }
        await markFailed(current, reason, {
          providerOperation: SERVICENOW_CREATE_FULFILLMENT_REQUEST,
          ...(err.operationId && { externalOperationId: err.operationId }),
        });
        fail(reason);
      }
      throw err;
    }
    const safe = {
      externalOperationId: operationId,
      serviceNowSysId: ticket.externalId,
      ticketNumber: ticket.externalReference,
    };
    if (ticket.via !== "already_succeeded" || !evidenceOf(request).serviceNowSysId) {
      await db
        .insert(auditEvents)
        .values(
          audit(
            request,
            "servicenow.fulfillment_requested",
            `access-request:${request.id}:fulfillment-requested`,
            safe,
          ),
        )
        .onConflictDoNothing();
    }

    // 6. Authoritative read-back: only ServiceNow's fulfillment_state decides.
    let record: AccessRequestRecord | null;
    try {
      record = await options.servicenow.getAccessRequest(ticket.externalId);
    } catch (err) {
      if (err instanceof ServiceNowError && !err.retryable) {
        await markFailed(current, err.code, safe);
        fail(err.code);
      }
      throw new ServiceNowFulfillmentError("RETRY_LATER", (err as Error).message, {
        retryable: true,
      });
    }
    if (!record) {
      await markFailed(current, "FULFILLMENT_RECORD_MISSING", safe);
      fail("FULFILLMENT_RECORD_MISSING");
    }
    const mismatched = fulfillmentRecordMismatches(record, {
      correlationKey: keys.correlationKey,
      resourceId: request.resourceId,
      workflowId: request.workflowId,
      employeeId: employee.hrisEmployeeId,
      requestedEntitlement: resource.displayName,
    });
    if (mismatched.length > 0) {
      await markFailed(current, "FULFILLMENT_RECORD_MISMATCH", {
        ...safe,
        mismatchedFields: mismatched,
      });
      fail("FULFILLMENT_RECORD_MISMATCH");
    }
    const state = record.fulfillmentState;
    const evidence = {
      serviceNowSysId: record.sysId,
      ticketNumber: record.number,
      operationId,
      correlationKey: keys.correlationKey,
      requestKind: record.requestKind,
      fulfillmentState: state,
      verifiedAt: new Date().toISOString(),
    };
    const base = {
      accessRequestId,
      resourceId: request.resourceId,
      replayed: false,
      sysId: record.sysId,
      number: record.number,
      operationId,
      fulfillmentState: state,
    };

    if (state === "failed") {
      await markFailed(current, "SERVICENOW_FULFILLMENT_FAILED", {
        ...safe,
        fulfillmentState: state,
      });
      logger.warn({ accessRequestId, number: record.number }, "servicenow fulfillment failed");
      fail("SERVICENOW_FULFILLMENT_FAILED");
    }
    if (state === "fulfilled") {
      const provisioned = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(accessRequests)
          .set({
            status: "PROVISIONED",
            provisioningOperationId: operationId,
            providerSubjectId: employee.hrisEmployeeId,
            providerTargetId: record.sysId,
            provisionedAt: clock,
            providerState: null,
            providerEvidence: evidence,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: clock,
          })
          .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
          .returning();
        if (row) {
          await tx
            .insert(auditEvents)
            .values([
              audit(
                request,
                "servicenow.fulfillment_verified",
                `access-request:${request.id}:fulfillment-verified`,
                {
                  ...safe,
                  fulfillmentState: state,
                },
              ),
              audit(request, "resource.provisioned", `access-request:${request.id}:provisioned`, {
                ...safe,
                provisioningOperationId: operationId,
              }),
            ])
            .onConflictDoNothing();
        }
        return row;
      });
      logger.info(
        { accessRequestId, number: record.number, replayed: !provisioned },
        "servicenow fulfillment verified",
      );
      return { ...base, status: "PROVISIONED", replayed: !provisioned };
    }
    // pending / in_progress (or not yet set): the human work is outstanding.
    const providerState =
      state === "in_progress" ? "FULFILLMENT_IN_PROGRESS" : "FULFILLMENT_PENDING";
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(accessRequests)
        .set({ providerState, providerEvidence: evidence, updatedAt: clock })
        .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
        .returning();
      if (row && request.providerState !== providerState) {
        await tx
          .insert(auditEvents)
          .values(
            audit(
              request,
              "servicenow.fulfillment_pending",
              `access-request:${request.id}:fulfillment:${providerState}`,
              { ...safe, fulfillmentState: state },
            ),
          )
          .onConflictDoNothing();
      }
    });
    return { ...base, status: providerState };
  }

  return { provisionServiceNowAccess };
}

export type FulfillmentCallbackOutcome = "RECORDED" | "UNKNOWN_TICKET" | "IDENTITY_MISMATCH";

export class FulfillmentCallbackError extends Error {
  constructor(
    readonly code: "EVENT_ID_CONFLICT" | "UNKNOWN_TICKET" | "IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "FulfillmentCallbackError";
  }
}

export interface ServiceNowFulfillmentCallbackService {
  /**
   * Records an AUTHENTICATED fulfillment notification and wakes provisioning. Makes no decision:
   * the worker reads the record back from ServiceNow. Idempotent per event id; the same event id
   * with different content is EVENT_ID_CONFLICT. No ServiceNow credentials are involved.
   */
  recordFulfillmentCallback(cb: ServiceNowFulfillmentCallback): Promise<{ duplicate: boolean }>;
}

export function createServiceNowFulfillmentCallbackService(
  db: Database,
): ServiceNowFulfillmentCallbackService {
  return {
    async recordFulfillmentCallback(cb) {
      const [op] = await db
        .select()
        .from(externalOperations)
        .where(
          and(
            eq(externalOperations.provider, "servicenow"),
            eq(externalOperations.operationType, SERVICENOW_CREATE_FULFILLMENT_REQUEST),
            eq(externalOperations.correlationKey, cb.correlationKey),
          ),
        );
      if (!op) {
        throw new FulfillmentCallbackError(
          "UNKNOWN_TICKET",
          "no fulfillment record of ours has this key",
        );
      }
      if (
        (op.externalId !== null && op.externalId !== cb.sysId) ||
        (op.externalReference !== null && op.externalReference !== cb.number)
      ) {
        throw new FulfillmentCallbackError(
          "IDENTITY_MISMATCH",
          "sys_id/number don't match our record",
        );
      }
      const accessRequestId = (op.request as { accessRequestId?: string }).accessRequestId!;
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            cb.eventId,
            cb.instance,
            cb.table,
            cb.sysId,
            cb.number,
            cb.correlationKey,
          ]),
        )
        .digest("hex");
      const key = `servicenow-fulfillment-callback:${cb.eventId}`;
      return db.transaction(async (tx) => {
        const [prior] = await tx
          .select({ payload: auditEvents.payload })
          .from(auditEvents)
          .where(eq(auditEvents.idempotencyKey, key));
        if (prior) {
          if (prior.payload.hash !== hash) {
            throw new FulfillmentCallbackError(
              "EVENT_ID_CONFLICT",
              "event id reused with different content",
            );
          }
          return { duplicate: true };
        }
        await tx.insert(auditEvents).values({
          workflowId: op.workflowId,
          eventType: "servicenow.fulfillment_callback_received",
          actor: "servicenow-callback",
          correlationId: `provisioning:${accessRequestId}`,
          idempotencyKey: key,
          payload: {
            eventId: cb.eventId,
            sysId: cb.sysId,
            number: cb.number,
            accessRequestId,
            externalOperationId: op.id,
            hash,
            // Diagnostic only; never used to decide.
            claimedFulfillmentState: cb.claimedFulfillmentState ?? null,
          },
        });
        // Make the request due now (it may be waiting on a scheduled reconcile), then wake M7C.
        await tx
          .update(accessRequests)
          .set({ nextReconcileAt: sql`clock_timestamp()` })
          .where(
            and(eq(accessRequests.id, accessRequestId), eq(accessRequests.status, "PROVISIONING")),
          );
        await enqueueProvisioningWake(tx, {
          workflowId: op.workflowId,
          reason: "SERVICENOW_FULFILLMENT_CHANGED",
          key: `fulfillment-callback:${cb.eventId}`,
        });
        return { duplicate: false };
      });
    },
  };
}
