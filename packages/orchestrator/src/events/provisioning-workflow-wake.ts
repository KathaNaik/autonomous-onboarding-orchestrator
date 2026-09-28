import { ProvisioningWorkflowWakePayloadSchema } from "@aoo/shared";
import type { ProvisioningCoordinator } from "../provisioning/coordinator.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/**
 * provisioning.workflow.wake → ProvisioningCoordinator.coordinateProvisioning (M7C). Idempotent
 * and safe under at-least-once delivery and concurrent workers; infrastructure errors are retried
 * by the outbox. Provider/human waits are not errors: they are recorded as blockers.
 */
export function createProvisioningWorkflowWakeHandler(
  coordinator: Pick<ProvisioningCoordinator, "coordinateProvisioning">,
): EventHandler {
  return async (event) => {
    const parsed = ProvisioningWorkflowWakePayloadSchema.safeParse(event.payload);
    if (!parsed.success)
      throw new PermanentEventError("invalid provisioning.workflow.wake payload");
    const result = await coordinator.coordinateProvisioning({
      workflowId: parsed.data.workflowId,
    });
    return {
      status: result.outcome === "NOT_APPLICABLE" ? "skipped" : "processed",
      detail: {
        reason: parsed.data.reason,
        outcome: result.outcome,
        planId: result.planId,
        planIssue: result.planIssue,
        workflowState: result.workflowState,
        dispatchOrder: result.dispatchOrder,
        transitioned: result.transitioned,
      },
    };
  };
}
