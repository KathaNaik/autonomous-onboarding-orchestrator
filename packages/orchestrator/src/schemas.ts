import { WorkflowStateSchema } from "@aoo/shared";
import { z } from "zod";

const ActorSchema = z.string().trim().min(1).max(200);
const CorrelationIdSchema = z.string().trim().min(1).max(200);

export const CreateWorkflowInputSchema = z.object({
  employee: z.object({
    hrisEmployeeId: z.string().trim().min(1),
    email: z.email(),
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
  }),
  actor: ActorSchema,
  correlationId: CorrelationIdSchema.optional(),
});
export type CreateWorkflowInput = z.input<typeof CreateWorkflowInputSchema>;

export const TransitionInputSchema = z
  .object({
    workflowId: z.uuid(),
    to: WorkflowStateSchema,
    expectedVersion: z.int().min(1),
    actor: ActorSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
    correlationId: CorrelationIdSchema.optional(),
  })
  .refine((input) => input.to !== "FAILED" || input.reason !== undefined, {
    message: "reason is required when transitioning to FAILED",
    path: ["reason"],
  });
export type TransitionInput = z.input<typeof TransitionInputSchema>;
