import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import type { WorkflowService } from "../workflow-service.js";
import { createHrisOfferSignedAcceptedHandler } from "./hris-offer-signed-accepted.js";
import type { EventHandlerRegistry } from "./types.js";

export * from "./hris-offer-signed-accepted.js";
export * from "./types.js";

export function createEventHandlers(deps: { workflows: WorkflowService }): EventHandlerRegistry {
  return {
    [OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted]: createHrisOfferSignedAcceptedHandler(
      deps.workflows,
    ),
  };
}
