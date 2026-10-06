import { createHash } from "node:crypto";
import {
  auditEvents,
  hrisEventReceipts,
  onboardingWorkflows,
  outboxEvents,
  type Database,
} from "@aoo/db";
import {
  HrisOfferSignedAcceptedPayloadSchema,
  HrisOfferSignedEventSchema,
  OUTBOX_EVENT_TYPES,
  TERMINAL_WORKFLOW_STATES,
  isOnboardingEligible,
  type HrisOfferSignedEvent,
} from "@aoo/shared";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { HrisEventConflictError, HrisEventNotEligibleError } from "./errors.js";
import { insertWorkflow, upsertEmployee } from "./workflow-writes.js";
import { outboxTraceColumns } from "./telemetry.js";

export const HRIS_ACTOR = "hris-webhook";

export interface HrisIntakeResult {
  receiptId: string;
  workflowId: string;
  /** True only if this delivery created the workflow. */
  workflowCreated: boolean;
  /** True if this eventId had already been accepted; nothing was written. */
  duplicate: boolean;
}

export interface HrisIntakeService {
  /**
   * Accepts an offer.signed event exactly once per eventId. In one transaction: records the
   * receipt, creates or reuses the employee's active workflow, and writes one outbox event.
   * Redelivery of the same event returns the original result with duplicate=true.
   */
  acceptOfferSigned(
    event: HrisOfferSignedEvent,
    /** (M11) Audit actor for operator-started onboardings (offer-letter intake); default HRIS. */
    options?: { actor?: string },
  ): Promise<HrisIntakeResult>;
}

export function createHrisIntakeService(db: Database): HrisIntakeService {
  return {
    async acceptOfferSigned(rawEvent, options = {}) {
      const actor = options.actor ?? HRIS_ACTOR;
      const event = HrisOfferSignedEventSchema.parse(rawEvent);
      if (!isOnboardingEligible(event)) {
        throw new HrisEventNotEligibleError(
          event.eventId,
          event.offerStatus,
          event.candidateStatus,
        );
      }
      // Hash the parsed event (schema-ordered keys), so retries that re-serialize the same
      // content still match while a reused eventId with different content does not.
      const payloadSha256 = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const correlationId = `hris:${event.eventId}`;

      return db.transaction(async (tx) => {
        // Serialize deliveries of the same eventId. The unique constraint on event_id is the
        // backstop; the lock lets the second delivery see the first one's committed receipt.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${correlationId}, 0))`);

        const [existing] = await tx
          .select()
          .from(hrisEventReceipts)
          .where(eq(hrisEventReceipts.eventId, event.eventId));
        if (existing) {
          if (existing.payloadSha256 !== payloadSha256) {
            throw new HrisEventConflictError(event.eventId);
          }
          return {
            receiptId: existing.id,
            workflowId: existing.workflowId,
            workflowCreated: false,
            duplicate: true,
          };
        }

        // Row-locks the employee, so different events for the same hire serialize here.
        const employee = await upsertEmployee(tx, {
          hrisEmployeeId: event.employeeId,
          ...event.employee,
          facts: {
            departmentCode: event.departmentCode,
            roleFamilyCode: event.roleFamilyCode,
            employmentType: event.employmentType,
            hrisEventId: event.eventId,
          },
        });
        const [active] = await tx
          .select()
          .from(onboardingWorkflows)
          .where(
            and(
              eq(onboardingWorkflows.employeeId, employee.id),
              notInArray(onboardingWorkflows.state, [...TERMINAL_WORKFLOW_STATES]),
            ),
          )
          .orderBy(desc(onboardingWorkflows.createdAt))
          .limit(1);

        const workflow =
          active ??
          (await insertWorkflow(tx, {
            employee,
            actor,
            correlationId,
            auditPayload: { hrisEventId: event.eventId },
          }));
        const workflowCreated = !active;

        const [receipt] = await tx
          .insert(hrisEventReceipts)
          .values({
            eventId: event.eventId,
            eventType: event.eventType,
            hrisEmployeeId: event.employeeId,
            payload: event,
            payloadSha256,
            workflowId: workflow.id,
            workflowCreated,
          })
          .returning();
        if (!receipt) throw new Error("receipt insert returned no row");

        if (!workflowCreated) {
          await tx.insert(auditEvents).values({
            workflowId: workflow.id,
            eventType: "hris.offer_signed.linked",
            actor,
            workflowVersion: workflow.version,
            correlationId,
            payload: { hrisEventId: event.eventId, receiptId: receipt.id },
          });
        }

        await tx.insert(outboxEvents).values({
          ...outboxTraceColumns(),
          idempotencyKey: `${OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted}:${event.eventId}`,
          aggregateType: "onboarding_workflow",
          aggregateId: workflow.id,
          eventType: OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted,
          payload: HrisOfferSignedAcceptedPayloadSchema.parse({
            workflowId: workflow.id,
            workflowCreated,
            receiptId: receipt.id,
            hrisEventId: event.eventId,
            hrisEventType: event.eventType,
            hrisEmployeeId: event.employeeId,
          }),
          correlationId,
        });

        return {
          receiptId: receipt.id,
          workflowId: workflow.id,
          workflowCreated,
          duplicate: false,
        };
      });
    },
  };
}
