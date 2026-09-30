import { outboxEvents, type Database, type Transaction } from "@aoo/db";
import {
  OUTBOX_EVENT_TYPES,
  OnboardingPlanGeneratePayloadSchema,
  type OnboardingPlanGeneratePayload,
} from "@aoo/shared";

/**
 * M8: writes an `onboarding.plan.generate` outbox event. Call it inside the transaction that moves
 * the workflow into ONBOARDING_GENERATION, so the request can never be lost after a commit. `key`
 * makes the event idempotent; the generation itself is idempotent anyway.
 */
export async function enqueueOnboardingPlanGeneration(
  tx: Transaction | Database,
  input: OnboardingPlanGeneratePayload & { key: string },
): Promise<boolean> {
  const payload = OnboardingPlanGeneratePayloadSchema.parse({
    workflowId: input.workflowId,
    reason: input.reason,
  });
  const inserted = await tx
    .insert(outboxEvents)
    .values({
      idempotencyKey: `${OUTBOX_EVENT_TYPES.onboardingPlanGenerate}:${input.key}`,
      aggregateType: "onboarding_workflow",
      aggregateId: input.workflowId,
      eventType: OUTBOX_EVENT_TYPES.onboardingPlanGenerate,
      payload,
      correlationId: `onboarding-plan:${input.workflowId}`,
    })
    .onConflictDoNothing()
    .returning({ id: outboxEvents.id });
  return inserted.length > 0;
}
