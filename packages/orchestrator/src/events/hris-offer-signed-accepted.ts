import { HrisOfferSignedAcceptedPayloadSchema } from "@aoo/shared";
import { InvalidTransitionError, WorkflowNotFoundError } from "../errors.js";
import { enqueueAccessPlanning } from "../access-planning/service.js";
import type { WorkflowService } from "../workflow-service.js";
import { PermanentEventError, type EventHandler } from "./types.js";

export const WORKER_ACTOR = "outbox-worker";

/** At most one start per workflow, across retries, duplicate deliveries and worker crashes. */
export const workflowStartKey = (workflowId: string) => `workflow-start:${workflowId}`;

/**
 * hris.offer_signed.accepted:
 * - workflowCreated=false → the event was linked to an already active workflow: acknowledge
 *   without touching it (never restart or duplicate execution).
 * - workflowCreated=true  → start the workflow: RECEIVED → ACCESS_PLANNING via WorkflowService,
 *   with a stable idempotency key so a retry after a committed transition is a no-op. (M10) The
 *   same transaction writes the access.planning.requested outbox event.
 */
export function createHrisOfferSignedAcceptedHandler(workflows: WorkflowService): EventHandler {
  return async (event, { logger }) => {
    const parsed = HrisOfferSignedAcceptedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new PermanentEventError(`invalid payload: ${parsed.error.message}`);
    }
    const { workflowId, workflowCreated } = parsed.data;

    if (!workflowCreated) {
      return {
        status: "skipped",
        detail: { reason: "ACTIVE_WORKFLOW_REUSED", workflowId },
      };
    }

    const details = await workflows.getWorkflow(workflowId);
    if (!details) throw new PermanentEventError(`workflow ${workflowId} not found`);

    try {
      const workflow = await workflows.transition(
        {
          workflowId,
          to: "ACCESS_PLANNING",
          expectedVersion: details.workflow.version,
          actor: WORKER_ACTOR,
          correlationId: event.correlationId ?? `outbox:${event.id}`,
          idempotencyKey: workflowStartKey(workflowId),
        },
        {
          // (M10) The durable request for access planning commits with the start itself.
          effects: (tx) =>
            enqueueAccessPlanning(tx, {
              workflowId,
              reason: "WORKFLOW_STARTED",
              key: `workflow-start:${workflowId}`,
            }).then(() => undefined),
        },
      );
      logger.info(
        { workflowId, state: workflow.state, version: workflow.version },
        "workflow started",
      );
      return {
        status: "processed",
        detail: { workflowId, state: workflow.state, version: workflow.version },
      };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        throw new PermanentEventError(err.message, { cause: err });
      }
      // Not in RECEIVED and never started by us (e.g. failed manually): nothing to start.
      if (err instanceof InvalidTransitionError) {
        return {
          status: "skipped",
          detail: { reason: "WORKFLOW_NOT_IN_RECEIVED", workflowId, state: err.from },
        };
      }
      throw err; // e.g. version conflict from a concurrent writer: retry re-reads.
    }
  };
}
