import { z } from "zod";

export const ServiceNameSchema = z.enum(["api", "web"]);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

/** Response body for every service's health endpoint. */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: ServiceNameSchema,
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
