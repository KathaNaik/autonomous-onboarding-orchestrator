import { ApprovalCallbackReceivedPayloadSchema } from "@aoo/shared";
import { ApprovalProcessingError, type ApprovalService } from "../approvals/service.js";
import { sanitizeExternalError } from "../external-operations/sanitize.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/** servicenow.approval_callback.received → verify against ServiceNow, apply once, resume. */
export function createApprovalCallbackHandler(service: ApprovalService): EventHandler {
  return async (event) => {
    const parsed = ApprovalCallbackReceivedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) throw new PermanentEventError("invalid approval callback payload");
    try {
      const r = await service.processCallback(parsed.data.callbackEventId);
      return {
        status: r.alreadyProcessed ? "skipped" : "processed",
        detail: {
          outcome: r.outcome,
          approvalStatus: r.approvalStatus,
          workflowResumed: r.workflowResumed,
        },
      };
    } catch (err) {
      if (err instanceof ApprovalProcessingError) {
        if (!err.retryable) throw new PermanentEventError(`${err.code}: ${err.message}`);
        throw new Error(`${err.code}: ${err.message}`);
      }
      const safe = sanitizeExternalError(err, { provider: "servicenow" });
      throw new Error(`${safe.code}: ${safe.message}`);
    }
  };
}
