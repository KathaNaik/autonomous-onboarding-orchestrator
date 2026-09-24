export type PolicyErrorCode =
  /** Policy data failed validation. Nothing is loaded: there are no partial policies. */
  | "INVALID_POLICY"
  /** The request itself is malformed. No decision is produced. */
  | "INVALID_REQUEST"
  /** The request's catalog reference isn't the catalog release this policy is bound to. */
  | "CATALOG_MISMATCH"
  /** An employee record lacks canonical facts (e.g. a pre-M5C row). No subject is produced. */
  | "INCOMPLETE_SUBJECT"
  | "DUPLICATE_RESOURCE"
  | "UNKNOWN_POLICY_VERSION"
  /** A recorded {policyVersion, policyHash} doesn't match the policy it is checked against. */
  | "POLICY_VERSION_MISMATCH";

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;
  /** Every problem found, for INVALID_POLICY and INVALID_REQUEST. */
  readonly issues: readonly string[];

  constructor(
    code: PolicyErrorCode,
    message: string,
    options: { issues?: readonly string[] } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.issues = Object.freeze([...(options.issues ?? [])]);
  }
}
