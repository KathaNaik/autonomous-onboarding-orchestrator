import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import type { WorkflowService } from "../workflow-service.js";
import type { ApprovalService } from "../approvals/service.js";
import type { ExternalOperationService } from "../external-operations/service.js";
import type { ProvisioningCoordinator } from "../provisioning/coordinator.js";
import { createApprovalCallbackHandler } from "./approval-callback-received.js";
import { createExternalOperationExecuteHandler } from "./external-operation-execute.js";
import { createHrisOfferSignedAcceptedHandler } from "./hris-offer-signed-accepted.js";
import { createProvisioningWorkflowWakeHandler } from "./provisioning-workflow-wake.js";
import type { EventHandlerRegistry } from "./types.js";

export * from "./approval-callback-received.js";
export * from "./external-operation-execute.js";
export * from "./hris-offer-signed-accepted.js";
export * from "./provisioning-workflow-wake.js";
export * from "./types.js";

export function createEventHandlers(deps: {
  workflows: WorkflowService;
  /** When set, the worker executes durable external operations (e.g. ServiceNow tickets). */
  externalOperations?: { service: ExternalOperationService; ownerId: string; leaseMs: number };
  /** When set, the worker verifies ServiceNow approval callbacks. */
  approvals?: ApprovalService;
  /** (M7C) When set, the worker drives provisioning on provisioning.workflow.wake. */
  provisioning?: Pick<ProvisioningCoordinator, "coordinateProvisioning">;
}): EventHandlerRegistry {
  return {
    [OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted]: createHrisOfferSignedAcceptedHandler(
      deps.workflows,
    ),
    ...(deps.externalOperations && {
      [OUTBOX_EVENT_TYPES.externalOperationExecute]: createExternalOperationExecuteHandler(
        deps.externalOperations.service,
        deps.externalOperations,
      ),
    }),
    ...(deps.approvals && {
      [OUTBOX_EVENT_TYPES.approvalCallbackReceived]: createApprovalCallbackHandler(deps.approvals),
    }),
    ...(deps.provisioning && {
      [OUTBOX_EVENT_TYPES.provisioningWorkflowWake]: createProvisioningWorkflowWakeHandler(
        deps.provisioning,
      ),
    }),
  };
}
