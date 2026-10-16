import { ApprovalRerequestRequestedPayloadSchema } from "@aoo/shared";
import {
  ApprovalRerequestRetryableError,
  type OperatorActionService,
} from "../operator-actions/service.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/**
 * approval.rerequest.requested → OperatorActionService.processApprovalRerequest (M13). Idempotent:
 * the replacement ticket is keyed by the resource's next retry generation, and the old approval is
 * superseded only while it is still PENDING. ServiceNow outages retry through the outbox.
 */
export function createApprovalRerequestHandler(
  service: Pick<OperatorActionService, "processApprovalRerequest">,
): EventHandler {
  return async (event) => {
    const parsed = ApprovalRerequestRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new PermanentEventError("invalid approval.rerequest.requested payload");
    }
    try {
      const result = await service.processApprovalRerequest(parsed.data);
      return {
        status: result.outcome === "REPLACED" ? "processed" : "skipped",
        detail: { ...result },
      };
    } catch (err) {
      if (err instanceof ApprovalRerequestRetryableError) {
        throw new Error(`approval re-request will be retried: ${err.message}`);
      }
      throw err;
    }
  };
}
