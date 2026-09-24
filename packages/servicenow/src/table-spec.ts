/**
 * The Onboarding Access Request table as it must exist in the ServiceNow scoped application
 * "Autonomous Onboarding". Single source of truth for the setup guide, the response schema and
 * the live schema check. Column names are scoped-app style (no u_ prefix).
 */
export const POLICY_DECISIONS = ["pending", "allow", "deny", "requires_approval"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

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
      name: "correlation_key",
      label: "Correlation Key",
      type: "string",
      maxLength: 255,
      mandatory: true,
      unique: true,
    },
  ] satisfies ColumnSpec[],
} as const;
