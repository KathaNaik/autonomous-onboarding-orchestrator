import { z } from "zod";

/** The subset of an Okta user the adapter reads. Unknown fields are ignored and never stored. */
export const OktaUserSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  profile: z.object({
    login: z.string(),
    email: z.string(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    employeeNumber: z.string().nullable().optional(),
  }),
});
export type OktaUser = z.infer<typeof OktaUserSchema>;

export const OktaGroupSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  profile: z.object({ name: z.string() }),
});
export type OktaGroup = z.infer<typeof OktaGroupSchema>;

/** The minimum profile M7A creates: authoritative HRIS identity attributes only. */
export const OktaNewUserSchema = z.strictObject({
  login: z.email().max(100),
  email: z.email().max(100),
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  employeeNumber: z.string().trim().min(1).max(100),
});
export type OktaNewUser = z.infer<typeof OktaNewUserSchema>;

/** Okta object ids: 20 characters, e.g. 00u… (users) and 00g… (groups). */
export const OKTA_USER_ID = /^00u[A-Za-z0-9]{17}$/;
export const OKTA_GROUP_ID = /^00g[A-Za-z0-9]{17}$/;
