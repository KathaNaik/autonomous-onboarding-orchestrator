import { z } from "zod";

/**
 * (M12) Self-registered operator accounts (user decision: anyone may sign up and becomes a full
 * operator; this is a proof of concept shown to a selected audience). The email is the operator
 * id, so it must fit the operator-id pattern used for audit actors (`hr:<email>`).
 */
export const OPERATOR_EMAIL_MAX_LENGTH = 64;
export const OPERATOR_PASSWORD_MIN_LENGTH = 12;
export const OPERATOR_PASSWORD_MAX_LENGTH = 128;

const EMAIL = /^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const OperatorEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(OPERATOR_EMAIL_MAX_LENGTH)
  .regex(EMAIL, "email: letters, digits, . _ - and one @, at most 64 characters");

export const OperatorPasswordSchema = z
  .string()
  .min(OPERATOR_PASSWORD_MIN_LENGTH)
  .max(OPERATOR_PASSWORD_MAX_LENGTH);

/** Body of `POST /admin/operator-accounts` and `POST /admin/operator-accounts/sign-in`. */
export const OperatorCredentialsSchema = z.strictObject({
  email: OperatorEmailSchema,
  password: OperatorPasswordSchema,
});
export type OperatorCredentials = z.infer<typeof OperatorCredentialsSchema>;

export const OperatorAccountResponseSchema = z.strictObject({ operatorId: z.string() });
export type OperatorAccountResponse = z.infer<typeof OperatorAccountResponseSchema>;

export const OPERATOR_ACCOUNT_ERROR_CODES = [
  "OPERATOR_UNAUTHORIZED",
  "INVALID_PAYLOAD",
  "UNSUPPORTED_MEDIA_TYPE",
  /** Sign-up for an email that already has an account (never says more). */
  "ACCOUNT_UNAVAILABLE",
  /** Wrong email, wrong password or a temporarily locked account: always the same answer. */
  "INVALID_CREDENTIALS",
  "SIGNUP_LIMIT_REACHED",
  "INTERNAL_ERROR",
] as const;
export const OperatorAccountErrorResponseSchema = z.object({
  error: z.enum(OPERATOR_ACCOUNT_ERROR_CODES),
  message: z.string(),
});
export type OperatorAccountErrorResponse = z.infer<typeof OperatorAccountErrorResponseSchema>;
