import { ExternalOperationExecutePayloadSchema } from "@aoo/shared";
import { ExternalOperationError } from "../external-operations/errors.js";
import { sanitizeExternalError } from "../external-operations/sanitize.js";
import type { ExternalOperationService } from "../external-operations/service.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/**
 * external_operation.execute → ExternalOperationService.execute. Errors are rethrown WITHOUT
 * their cause chain and with sanitized messages, so the outbox's last_error/attempt history can
 * never capture credentials or payload values.
 */
export function createExternalOperationExecuteHandler(
  service: ExternalOperationService,
  owner: { ownerId: string; leaseMs: number },
): EventHandler {
  return async (event, { logger }) => {
    const parsed = ExternalOperationExecutePayloadSchema.safeParse(event.payload);
    if (!parsed.success)
      throw new PermanentEventError("invalid external_operation.execute payload");
    try {
      const result = await service.execute(parsed.data.operationId, owner);
      return {
        status: result.via === "already_succeeded" ? "skipped" : "processed",
        detail: {
          operationId: result.operationId,
          externalReference: result.externalReference,
          via: result.via,
        },
      };
    } catch (err) {
      if (err instanceof ExternalOperationError) {
        logger.warn(
          { operationId: err.operationId, code: err.code, retryable: err.retryable },
          "external operation not completed",
        );
        if (!err.retryable) throw new PermanentEventError(`${err.code}: ${err.message}`);
        throw new Error(`${err.code}: ${err.message}`);
      }
      const safe = sanitizeExternalError(err, { provider: parsed.data.provider });
      throw new Error(`${safe.code}: ${safe.message}`);
    }
  };
}
