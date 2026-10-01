import { AccessPlanningRequestedPayloadSchema } from "@aoo/shared";
import { AccessPlanningError, type AccessPlanningService } from "../access-planning/service.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/**
 * access.planning.requested → AccessPlanningService.planAccess (M10). Idempotent under
 * at-least-once delivery: the Role Access run and the authorization both replay. Transient
 * failures (model outage, busy run, workflow conflict) retry through the outbox; deterministic
 * ones dead-letter visibly and are not re-requested by the sweep.
 */
export function createAccessPlanningRequestedHandler(
  service: Pick<AccessPlanningService, "planAccess">,
): EventHandler {
  return async (event) => {
    const parsed = AccessPlanningRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) throw new PermanentEventError("invalid access.planning.requested payload");
    try {
      const result = await service.planAccess({ workflowId: parsed.data.workflowId });
      return {
        status: result.outcome === "AUTHORIZED" ? "processed" : "skipped",
        detail: {
          reason: parsed.data.reason,
          outcome: result.outcome,
          workflowState: result.workflowState,
          agentRunId: result.agentRunId,
          recommendationReplayed: result.recommendationReplayed,
          ...(result.summary && { summary: result.summary }),
        },
      };
    } catch (err) {
      if (err instanceof AccessPlanningError && !err.retryable) {
        throw new PermanentEventError(`access planning stopped: ${err.code}`);
      }
      if (err instanceof AccessPlanningError) {
        throw new Error(`access planning will be retried: ${err.code}`);
      }
      throw err;
    }
  };
}

/** Registered when the Role Access Agent is disabled: acknowledged; the sweep re-requests later. */
export const accessPlanningDisabledHandler: EventHandler = async () => ({
  status: "skipped",
  detail: { outcome: "ROLE_ACCESS_AGENT_DISABLED" },
});
