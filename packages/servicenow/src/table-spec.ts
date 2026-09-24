/**
 * The Onboarding Access Request table as it must exist in the ServiceNow scoped application
 * "Autonomous Onboarding". Single source of truth for the setup guide, the response schema and
 * the live schema check. Column names are scoped-app style (no u_ prefix).
 */
export const POLICY_DECISIONS = ["pending", "allow", "deny", "requires_approval"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/**
 * Human approval of the request in ServiceNow (M4C). Separate from policy_decision (what our
 * policy concluded) and from Task's built-in approval engine. Only an approver changes it.
 */
export const APPROVAL_STATES = ["not_required", "pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export interface ColumnSpec {
  name: string;
  label: string;
  /** Table Builder type ("String" → string, "Choice" → choice). */
  type: "string" | "choice";
  maxLength: number;
  mandatory: boolean;
  unique?: boolean;
  choices?: readonly string[];
  defaultValue?: string;
}

export const ACCESS_REQUEST_TABLE_SPEC = {
  applicationName: "Autonomous Onboarding",
  tableLabel: "Onboarding Access Request",
  /** The scoped name suffix; ServiceNow prepends the scope, e.g. x_1234567_autonomous_0_. */
  tableNameSuffix: "onboarding_access_request",
  extends: "task",
  columns: [
    { name: "employee_id", label: "Employee ID", type: "string", maxLength: 100, mandatory: true },
    { name: "workflow_id", label: "Workflow ID", type: "string", maxLength: 40, mandatory: true },
    { name: "resource_id", label: "Resource ID", type: "string", maxLength: 255, mandatory: true },
    {
      name: "requested_entitlement",
      label: "Requested Entitlement",
      type: "string",
      maxLength: 255,
      mandatory: true,
    },
    {
      name: "agent_reason",
      label: "Agent Reason",
      type: "string",
      maxLength: 4000,
      mandatory: false,
    },
    {
      name: "policy_decision",
      label: "Policy Decision",
      type: "choice",
      maxLength: 40,
      mandatory: true,
      choices: POLICY_DECISIONS,
      defaultValue: "pending",
    },
    {
      name: "approval_state",
      label: "Approval State",
      type: "choice",
      maxLength: 40,
      mandatory: true,
      choices: APPROVAL_STATES,
      defaultValue: "not_required",
    },
    {
      name: "correlation_key",
      label: "Correlation Key",
      type: "string",
      maxLength: 255,
      mandatory: true,
      unique: true,
    },
  ] satisfies ColumnSpec[],
} as const;
