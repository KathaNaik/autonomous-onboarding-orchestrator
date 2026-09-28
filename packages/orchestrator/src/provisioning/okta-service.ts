import { CatalogError, type CatalogRegistry, type CatalogResource } from "@aoo/catalog";
import {
  accessDecisions,
  accessRequests,
  approvals,
  auditEvents,
  employees,
  externalIdentities,
  externalOperations,
  type AccessRequest,
  type Database,
  type Employee,
} from "@aoo/db";
import { OktaNewUserSchema, type OktaGroupTarget } from "@aoo/okta";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { noopLogger, type EventLogger } from "../events/types.js";
import { ExternalOperationError } from "../external-operations/errors.js";
import type { ExecutionSuccess, ExternalOperationService } from "../external-operations/service.js";
import {
  EligibilityError,
  loadAuthorizedRequest,
  missingDependencies,
  resolveProviderResource,
  type AuthorizedRequest,
} from "./eligibility.js";
import {
  OKTA_ADD_GROUP_MEMBERSHIP,
  OKTA_ENSURE_USER,
  identityMismatches,
  oktaEnsureUserKeys,
  oktaMembershipKeys,
  type OktaGateway,
} from "./okta-handlers.js";

export const OKTA_PROVISIONING_ACTOR = "okta-provisioning";

export type OktaProvisioningErrorCode =
  | "INVALID_INPUT"
  | "ACCESS_REQUEST_NOT_FOUND"
  /** DENIED, REJECTED, AWAITING_APPROVAL or otherwise not authorized for provisioning. */
  | "NOT_ELIGIBLE"
  /** Access request, decision and approval don't form a valid authorization chain. */
  | "AUTHORIZATION_CHAIN_INVALID"
  | "CATALOG_UNAVAILABLE"
  | "RESOURCE_NOT_IN_CATALOG"
  | "PROVIDER_MISMATCH"
  | "OKTA_TARGET_NOT_CONFIGURED"
  | "DEPENDENCIES_NOT_READY"
  | "MISSING_IDENTITY_ATTRIBUTE"
  /** Terminal: provider conflict or deterministic failure; the resource is PROVISIONING_FAILED. */
  | "PROVISIONING_FAILED"
  /** Transient: another owner is working, or the provider was unavailable. Re-invoke later. */
  | "RETRY_LATER";

export class OktaProvisioningError extends Error {
  readonly code: OktaProvisioningErrorCode;
  readonly retryable: boolean;
  readonly accessRequestId: string | undefined;
  /** Stable provider-side reason (e.g. AMBIGUOUS_OKTA_IDENTITY) for PROVISIONING_FAILED. */
  readonly reason: string | undefined;

  constructor(
    code: OktaProvisioningErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      accessRequestId?: string | undefined;
      reason?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.accessRequestId = options.accessRequestId;
    this.reason = options.reason;
  }
}

export interface OktaProvisioningResult {
  readonly accessRequestId: string;
  readonly accessDecisionId: string;
  readonly workflowId: string;
  /** HRIS employee id. */
  readonly employeeId: string;
  readonly resourceId: string;
  readonly status: "PROVISIONED";
  /** True when the request was already PROVISIONED (no provider call). */
  readonly replayed: boolean;
  readonly oktaUserId: string;
  readonly oktaGroupId: string;
  /** LINKED: existing verified link; RESOLVED: existing Okta user adopted; CREATED: new user. */
  readonly identity: "LINKED" | "RESOLVED" | "CREATED" | "REPLAYED";
  /** ADDED: membership written now; ALREADY_PRESENT: Okta already had it. */
  readonly membership: "ADDED" | "ALREADY_PRESENT" | "REPLAYED";
  readonly identityOperationId: string | null;
  readonly membershipOperationId: string;
  readonly provisionedAt: Date;
}

export interface OktaProvisioningService {
  /**
   * Provisions exactly one authorized OKTA access request. Idempotent and safe to call
   * concurrently: one Okta identity per employee, one membership operation per request, one
   * PROVISIONED transition. Never provisions other resources or dependencies.
   */
  provisionOktaAccess(input: { accessRequestId: string }): Promise<OktaProvisioningResult>;
}

export interface OktaProvisioningServiceOptions {
  catalogs: CatalogRegistry;
  /** The durable executor, configured with the Okta handlers (createOktaHandlers). */
  externalOperations: ExternalOperationService;
  /** Read access for verifying an existing identity link. */
  okta: Pick<OktaGateway, "getUser">;
  targets: ReadonlyMap<string, OktaGroupTarget>;
  ownerId?: string;
  leaseMs?: number;
  /** How long to wait for another owner of the same operation before RETRY_LATER. */
  busyWaitMs?: number;
  logger?: EventLogger;
}

const clock = sql`clock_timestamp()`;
const InputSchema = z.strictObject({ accessRequestId: z.uuid() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createOktaProvisioningService(
  db: Database,
  options: OktaProvisioningServiceOptions,
): OktaProvisioningService {
  const { catalogs, externalOperations: extOps, okta, targets } = options;
  const ownerId = options.ownerId ?? `okta-provisioner-${process.pid}`;
  const leaseMs = options.leaseMs ?? 60_000;
  const busyWaitMs = options.busyWaitMs ?? 5_000;
  const logger = options.logger ?? noopLogger;

  /** Executes an operation; waits (bounded) while another owner holds it. */
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
          version: sql`${accessRequests.version} + 1`,
          updatedAt: clock,
        })
        .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
        .returning();
      if (row) {
        await tx
          .insert(auditEvents)
          .values({
            workflowId: request.workflowId,
            eventType: "resource.provisioning_failed",
            actor: OKTA_PROVISIONING_ACTOR,
            correlationId: `provisioning:${request.id}`,
            idempotencyKey: `access-request:${request.id}:provisioning-failed`,
            payload: {
              accessRequestId: request.id,
              resourceId: request.resourceId,
              provider: "OKTA",
              reason,
              ...context,
            },
          })
          .onConflictDoNothing();
      }
    });
  }

  /** Maps an executor failure: transient → RETRY_LATER; terminal → PROVISIONING_FAILED. */
  async function onOperationError(
    err: unknown,
    request: AccessRequest,
    providerOperation: string,
  ): Promise<never> {
    if (err instanceof ExternalOperationError && err.retryable) {
      throw new OktaProvisioningError("RETRY_LATER", `${providerOperation}: ${err.message}`, {
        retryable: true,
        accessRequestId: request.id,
      });
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
      if (err.code === "IDEMPOTENCY_CONFLICT") reason = "IDENTITY_ATTRIBUTES_CHANGED";
      await markFailed(request, reason, {
        providerOperation,
        ...(err.operationId && { externalOperationId: err.operationId }),
      });
      throw new OktaProvisioningError(
        "PROVISIONING_FAILED",
        `${providerOperation} stopped: ${reason}`,
        {
          accessRequestId: request.id,
          reason,
        },
      );
    }
    throw err;
  }

  function replayResult(
    request: AccessRequest,
    decisionId: string,
    hrisEmployeeId: string,
  ): OktaProvisioningResult {
    return Object.freeze({
      accessRequestId: request.id,
      accessDecisionId: decisionId,
      workflowId: request.workflowId,
      employeeId: hrisEmployeeId,
      resourceId: request.resourceId,
      status: "PROVISIONED" as const,
      replayed: true,
      oktaUserId: request.providerSubjectId!,
      oktaGroupId: request.providerTargetId!,
      identity: "REPLAYED" as const,
      membership: "REPLAYED" as const,
      identityOperationId: null,
      membershipOperationId: request.provisioningOperationId!,
      provisionedAt: request.provisionedAt!,
    });
  }

  return {
    async provisionOktaAccess(rawInput) {
      const parsed = InputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new OktaProvisioningError(
          "INVALID_INPUT",
          "provisionOktaAccess needs an access request uuid",
        );
      const { accessRequestId } = parsed.data;
      const started = performance.now();

      // 1–3. Authorization chain, exact catalog resource and dependencies (shared, fail-closed).
      const eligible = <T>(fn: () => T): T => {
        try {
          return fn();
        } catch (err) {
          if (err instanceof EligibilityError) {
            throw new OktaProvisioningError(err.code, err.message, { accessRequestId });
          }
          throw err;
        }
      };
      let authorized: AuthorizedRequest;
      try {
        authorized = await loadAuthorizedRequest(db, accessRequestId);
      } catch (err) {
        if (err instanceof EligibilityError) {
          throw new OktaProvisioningError(err.code, err.message, { accessRequestId });
        }
        throw err;
      }
      const { request, decision, employee } = authorized;
      if (request.status === "PROVISIONING_FAILED") {
        throw new OktaProvisioningError(
          "PROVISIONING_FAILED",
          `provisioning failed earlier: ${request.provisioningErrorCode}`,
          {
            accessRequestId,
            reason: request.provisioningErrorCode ?? undefined,
          },
        );
      }
      if (request.status === "PROVISIONED") {
        return replayResult(request, decision.id, employee.hrisEmployeeId);
      }
      const resource = eligible(() => resolveProviderResource(catalogs, decision, request, "OKTA"));
      if (resource.provider !== "OKTA") throw new Error("unreachable: provider already checked");
      const target = targets.get(resource.resourceId);
      if (!target) {
        throw new OktaProvisioningError(
          "OKTA_TARGET_NOT_CONFIGURED",
          `no Okta group is configured for ${resource.resourceId}`,
          { accessRequestId },
        );
      }
      const expectedGroupName = target.expectedName ?? resource.providerMetadata.groupName;
      const missingDeps = await missingDependencies(db, request, resource);
      if (missingDeps.length > 0) {
        throw new OktaProvisioningError(
          "DEPENDENCIES_NOT_READY",
          `dependencies not provisioned: ${missingDeps.join(", ")}`,
          { accessRequestId },
        );
      }

      // 4. Authoritative HRIS identity attributes (fail before any Okta write).
      const profile = identityProfile(employee);
      if (!profile) {
        throw new OktaProvisioningError(
          "MISSING_IDENTITY_ATTRIBUTE",
          "the employee lacks a required identity attribute",
          { accessRequestId },
        );
      }

      // 5. Claim provisioning intent (short transaction; no provider call inside).
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
            .values({
              workflowId: request.workflowId,
              eventType: "resource.provisioning_started",
              actor: OKTA_PROVISIONING_ACTOR,
              correlationId: `provisioning:${request.id}`,
              idempotencyKey: `access-request:${request.id}:provisioning-started`,
              payload: {
                accessRequestId: request.id,
                accessDecisionId: decision.id,
                resourceId: request.resourceId,
                provider: "OKTA",
              },
            })
            .onConflictDoNothing();
        }
      });
      const current = { ...request, status: "PROVISIONING" as const };

      // 6. Okta identity: verified link, or the identity-level durable operation.
      let oktaUserId: string;
      let identity: OktaProvisioningResult["identity"];
      let identityOperationId: string | null = null;
      const [link] = await db
        .select()
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.employeeId, employee.id),
            eq(externalIdentities.provider, "okta"),
          ),
        );
      if (link) {
        let user;
        try {
          user = await okta.getUser(link.providerSubjectId);
        } catch {
          throw new OktaProvisioningError("RETRY_LATER", "could not verify the linked Okta user", {
            retryable: true,
            accessRequestId,
          });
        }
        const mismatched = user ? identityMismatches(user, profile) : ["missing"];
        if (mismatched.length > 0) {
          await markFailed(current, user ? "OKTA_IDENTITY_CONFLICT" : "OKTA_LINKED_USER_MISSING", {
            oktaUserId: link.providerSubjectId,
            mismatchedFields: mismatched,
          });
          throw new OktaProvisioningError(
            "PROVISIONING_FAILED",
            "the linked Okta user no longer matches the employee",
            {
              accessRequestId,
              reason: user ? "OKTA_IDENTITY_CONFLICT" : "OKTA_LINKED_USER_MISSING",
            },
          );
        }
        oktaUserId = link.providerSubjectId;
        identity = "LINKED";
      } else {
        const keys = oktaEnsureUserKeys(employee.id);
        let ensured: ExecutionSuccess;
        try {
          const { operation } = await extOps.requestOperation({
            workflowId: request.workflowId,
            provider: "okta",
            operationType: OKTA_ENSURE_USER,
            ...keys,
            request: { employeeId: employee.id, profile },
            actor: OKTA_PROVISIONING_ACTOR,
            enqueueExecution: false,
          });
          identityOperationId = operation.id;
          ensured = await executeOrWait(operation.id);
        } catch (err) {
          return onOperationError(err, current, OKTA_ENSURE_USER);
        }
        oktaUserId = ensured.externalId;
        // "reconciled": the user already existed before any write of ours. "created" and
        // "reconciled_after_unknown": our own (possibly uncertain) create took effect.
        identity = ensured.via === "reconciled" ? "RESOLVED" : "CREATED";
        // Link it (unique per employee and per provider subject).
        const linked = await db.transaction(async (tx) => {
          await tx
            .insert(externalIdentities)
            .values({
              employeeId: employee.id,
              provider: "okta",
              providerSubjectId: oktaUserId,
              providerLogin: ensured.externalReference,
              linkedByOperationId: ensured.operationId,
              verifiedAt: clock as unknown as Date,
            })
            .onConflictDoNothing();
          const [mine] = await tx
            .select()
            .from(externalIdentities)
            .where(
              and(
                eq(externalIdentities.employeeId, employee.id),
                eq(externalIdentities.provider, "okta"),
              ),
            );
          if (mine?.providerSubjectId === oktaUserId) {
            await tx
              .insert(auditEvents)
              .values({
                workflowId: request.workflowId,
                eventType:
                  identity === "CREATED" ? "okta.identity_created" : "okta.identity_resolved",
                actor: OKTA_PROVISIONING_ACTOR,
                correlationId: `provisioning:${request.id}`,
                idempotencyKey: `external-identity:${mine.id}:linked`,
                payload: {
                  employeeId: employee.id,
                  externalIdentityId: mine.id,
                  oktaUserId,
                  externalOperationId: ensured.operationId,
                },
              })
              .onConflictDoNothing();
            return true;
          }
          return false;
        });
        if (!linked) {
          await markFailed(current, "OKTA_SUBJECT_LINK_CONFLICT", { oktaUserId });
          throw new OktaProvisioningError(
            "PROVISIONING_FAILED",
            "the Okta user is linked to another employee, or the employee to another user",
            { accessRequestId, reason: "OKTA_SUBJECT_LINK_CONFLICT" },
          );
        }
      }

      // 7. Group membership: one durable operation per authorized request and target.
      const keys = oktaMembershipKeys({
        accessDecisionId: decision.id,
        accessRequestId: request.id,
        groupId: target.groupId,
      });
      let applied: ExecutionSuccess;
      let membershipOperationId: string;
      try {
        const { operation } = await extOps.requestOperation({
          workflowId: request.workflowId,
          provider: "okta",
          operationType: OKTA_ADD_GROUP_MEMBERSHIP,
          ...keys,
          request: {
            accessRequestId: request.id,
            accessDecisionId: decision.id,
            resourceId: request.resourceId,
            oktaUserId,
            groupId: target.groupId,
            expectedGroupName,
          },
          actor: OKTA_PROVISIONING_ACTOR,
          enqueueExecution: false,
        });
        membershipOperationId = operation.id;
        applied = await executeOrWait(operation.id);
      } catch (err) {
        return onOperationError(err, current, OKTA_ADD_GROUP_MEMBERSHIP);
      }
      const membership: OktaProvisioningResult["membership"] =
        applied.via === "reconciled" ? "ALREADY_PRESENT" : "ADDED";

      // 8. Persist PROVISIONED only after the verified outcome (short transaction).
      const completed = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(accessRequests)
          .set({
            status: "PROVISIONED",
            provisioningOperationId: membershipOperationId,
            providerSubjectId: oktaUserId,
            providerTargetId: target.groupId,
            provisionedAt: clock,
            version: sql`${accessRequests.version} + 1`,
            updatedAt: clock,
          } as never)
          .where(and(eq(accessRequests.id, request.id), eq(accessRequests.status, "PROVISIONING")))
          .returning();
        if (!row) return null;
        const payload = {
          accessRequestId: request.id,
          accessDecisionId: decision.id,
          employeeId: employee.id,
          resourceId: request.resourceId,
          provider: "OKTA",
          externalOperationId: membershipOperationId,
          oktaUserId,
          oktaGroupId: target.groupId,
        };
        await tx
          .insert(auditEvents)
          .values([
            {
              workflowId: request.workflowId,
              eventType:
                membership === "ADDED"
                  ? "okta.group_membership_provisioned"
                  : "okta.group_membership_already_present",
              actor: OKTA_PROVISIONING_ACTOR,
              correlationId: `provisioning:${request.id}`,
              idempotencyKey: `access-request:${request.id}:okta-membership`,
              payload,
            },
            {
              workflowId: request.workflowId,
              eventType: "resource.provisioned",
              actor: OKTA_PROVISIONING_ACTOR,
              correlationId: `provisioning:${request.id}`,
              idempotencyKey: `access-request:${request.id}:provisioned`,
              payload,
            },
          ])
          .onConflictDoNothing();
        return row;
      });
      const final =
        completed ??
        (await db.select().from(accessRequests).where(eq(accessRequests.id, request.id)))[0]!;
      if (final.status !== "PROVISIONED") {
        throw new OktaProvisioningError("RETRY_LATER", `access request is ${final.status}`, {
          retryable: true,
          accessRequestId,
        });
      }
      logger.info(
        {
          provider: "OKTA",
          workflowId: request.workflowId,
          employeeId: employee.id,
          resourceId: request.resourceId,
          accessRequestId: request.id,
          accessDecisionId: decision.id,
          externalOperationId: membershipOperationId,
          providerOperation: OKTA_ADD_GROUP_MEMBERSHIP,
          identity,
          membership,
          reconciliation: applied.via,
          outcome: completed ? "PROVISIONED" : "ALREADY_PROVISIONED",
          latencyMs: Math.round(performance.now() - started),
        },
        "okta access provisioned",
      );
      if (!completed) return replayResult(final, decision.id, employee.hrisEmployeeId);
      return Object.freeze({
        accessRequestId: request.id,
        accessDecisionId: decision.id,
        workflowId: request.workflowId,
        employeeId: employee.hrisEmployeeId,
        resourceId: request.resourceId,
        status: "PROVISIONED" as const,
        replayed: false,
        oktaUserId,
        oktaGroupId: target.groupId,
        identity,
        membership,
        identityOperationId,
        membershipOperationId,
        provisionedAt: final.provisionedAt!,
      });
    },
  };
}

/** Authoritative HRIS identity: login and email are the HRIS work email; nothing is invented. */
function identityProfile(employee: Employee) {
  const parsed = OktaNewUserSchema.safeParse({
    login: employee.email?.trim(),
    email: employee.email?.trim(),
    firstName: employee.firstName?.trim(),
    lastName: employee.lastName?.trim(),
    employeeNumber: employee.hrisEmployeeId?.trim(),
  });
  return parsed.success ? parsed.data : null;
}
