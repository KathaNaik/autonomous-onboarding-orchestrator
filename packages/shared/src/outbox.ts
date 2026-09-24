import { z } from "zod";

/** Emitted once per accepted HRIS offer.signed event. Consumed by the outbox worker (M3B). */
export const HrisOfferSignedAcceptedPayloadSchema = z.object({
  workflowId: z.uuid(),
  workflowCreated: z.boolean(),
  receiptId: z.uuid(),
  hrisEventId: z.string(),
  hrisEventType: z.literal("offer.signed"),
  hrisEmployeeId: z.string(),
});
export type HrisOfferSignedAcceptedPayload = z.infer<typeof HrisOfferSignedAcceptedPayloadSchema>;

export const OUTBOX_EVENT_TYPES = {
  hrisOfferSignedAccepted: "hris.offer_signed.accepted",
  externalOperationExecute: "external_operation.execute",
  approvalCallbackReceived: "servicenow.approval_callback.received",
} as const;

/** Asks a worker to execute (or resume/reconcile) one durable external operation. */
export const ExternalOperationExecutePayloadSchema = z.object({
  operationId: z.uuid(),
  provider: z.string(),
  operationType: z.string(),
});
export type ExternalOperationExecutePayload = z.infer<typeof ExternalOperationExecutePayloadSchema>;
