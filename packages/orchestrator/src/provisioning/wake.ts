import { outboxEvents, type Database, type Transaction } from "@aoo/db";
import {
  OUTBOX_EVENT_TYPES,
  ProvisioningWorkflowWakePayloadSchema,
  type ProvisioningWorkflowWakePayload,
} from "@aoo/shared";

/**
 * M7C: writes a `provisioning.workflow.wake` outbox event. Call it inside the transaction that
 * makes provisioning progress possible, so the wake can never be lost after a commit. `key` makes
 * the event idempotent (duplicates are dropped; the coordinator is idempotent anyway).
 */
export async function enqueueProvisioningWake(
  tx: Transaction | Database,
  input: ProvisioningWorkflowWakePayload & { key: string; correlationId?: string },
): Promise<boolean> {
  const payload = ProvisioningWorkflowWakePayloadSchema.parse({
    workflowId: input.workflowId,
    reason: input.reason,
  });
  const inserted = await tx
    .insert(outboxEvents)
    .values({
      idempotencyKey: `${OUTBOX_EVENT_TYPES.provisioningWorkflowWake}:${input.key}`,
      aggregateType: "onboarding_workflow",
      aggregateId: input.workflowId,
      eventType: OUTBOX_EVENT_TYPES.provisioningWorkflowWake,
      payload,
      correlationId: input.correlationId ?? `provisioning:${input.workflowId}`,
    })
    .onConflictDoNothing()
    .returning({ id: outboxEvents.id });
  return inserted.length > 0;
}
