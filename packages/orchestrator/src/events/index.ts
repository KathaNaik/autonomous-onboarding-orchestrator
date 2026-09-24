import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import type { WorkflowService } from "../workflow-service.js";
import type { ExternalOperationService } from "../external-operations/service.js";
import { createExternalOperationExecuteHandler } from "./external-operation-execute.js";
import { createHrisOfferSignedAcceptedHandler } from "./hris-offer-signed-accepted.js";
import type { EventHandlerRegistry } from "./types.js";

export * from "./external-operation-execute.js";
export * from "./hris-offer-signed-accepted.js";
export * from "./types.js";

export function createEventHandlers(deps: {
  workflows: WorkflowService;
  /** When set, the worker executes durable external operations (e.g. ServiceNow tickets). */
  externalOperations?: { service: ExternalOperationService; ownerId: string; leaseMs: number };
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
  };
}
