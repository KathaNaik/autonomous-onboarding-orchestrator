import { z } from "zod";

/**
 * (M10) Public, read-only portfolio demo. A deliberately STRICTER model than the operator read
 * model: it has no identifiers at all (no workflow/request/decision/operation ids, no HRIS ids,
 * e-mails, ticket numbers, sys_ids, correlation keys, provider ids or operator ids). The
 * scenarios are synthetic, bundled with the web app and validated at load: the demo never calls
 * the API or the database and cannot be pointed at a real workflow.
 */
const Text = z.string().min(1).max(600);
const ResourceId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);

export const DEMO_SLUGS = ["completed", "awaiting-approval", "github-invitation-pending"] as const;
export type DemoSlug = (typeof DEMO_SLUGS)[number];

export const DemoResourceSchema = z.strictObject({
  resourceId: ResourceId,
  displayName: Text,
  provider: z.enum(["OKTA", "GITHUB", "SERVICENOW", "MANUAL"]),
  decision: z.enum(["ALLOW", "DENY", "REQUIRES_APPROVAL"]),
  reason: Text,
  authorization: z.enum([
    "AUTHORIZED_BY_POLICY",
    "AUTHORIZED_BY_APPROVAL",
    "PENDING_APPROVAL",
    "DENIED_BY_POLICY",
    "REJECTED_BY_APPROVER",
  ]),
  status: z.enum([
    "READY_FOR_PROVISIONING",
    "PROVISIONING",
    "PROVISIONED",
    "AWAITING_APPROVAL",
    "MANUAL_ACTION_REQUIRED",
    "DENIED",
    "REJECTED",
  ]),
  dependsOn: z.array(ResourceId).max(5),
  waitingOn: Text.nullable(),
});

export const DemoScenarioSchema = z.strictObject({
  slug: z.enum(DEMO_SLUGS),
  title: Text,
  summary: Text,
  state: z.enum([
    "RECEIVED",
    "ACCESS_PLANNING",
    "POLICY_REVIEW",
    "AWAITING_APPROVAL",
    "PROVISIONING",
    "ONBOARDING_GENERATION",
    "COMPLETED",
  ]),
  hire: z.strictObject({
    displayName: Text,
    jobTitle: Text,
    department: Text,
    roleFamily: Text,
    employmentType: Text,
  }),
  versions: z.strictObject({ catalog: z.string(), policy: z.string(), prompt: z.string() }),
  resources: z.array(DemoResourceSchema).max(12),
  timeline: z.array(z.strictObject({ at: z.iso.datetime(), label: Text, actor: Text })).max(40),
  plan: z
    .strictObject({
      summary: Text,
      tasks: z
        .array(
          z.strictObject({
            phase: z.enum(["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"]),
            title: Text,
            instruction: Text,
            resourceIds: z.array(ResourceId).max(5),
          }),
        )
        .min(3)
        .max(12),
    })
    .nullable(),
});
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;

const VERSIONS = { catalog: "1.0.0", policy: "1.1.0", prompt: "onboarding-plan.v1" };
const t = (minute: number) =>
  new Date(Date.UTC(2026, 8, 21, 16, 0) + minute * 60_000).toISOString();

const RAW: DemoScenario[] = [
  {
    slug: "completed",
    title: "Completed onboarding: backend engineer",
    summary:
      "Every tool is set up, including production access once an approver signed off, and the new hire has a first-month plan.",
    state: "COMPLETED",
    hire: {
      displayName: "Ada Example",
      jobTitle: "Backend Software Engineer",
      department: "Engineering",
      roleFamily: "Software engineer",
      employmentType: "Full time",
    },
    versions: VERSIONS,
    resources: [
      {
        resourceId: "okta-engineering-group",
        displayName: "Okta engineering group",
        provider: "OKTA",
        decision: "ALLOW",
        reason: "Engineering baseline access.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONED",
        dependsOn: [],
        waitingOn: null,
      },
      {
        resourceId: "github-org-membership",
        displayName: "GitHub organization membership",
        provider: "GITHUB",
        decision: "ALLOW",
        reason: "Engineering baseline access.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONED",
        dependsOn: [],
        waitingOn: null,
      },
      {
        resourceId: "github-team-backend",
        displayName: "GitHub backend team",
        provider: "GITHUB",
        decision: "ALLOW",
        reason: "Engineering team access for software engineers.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONED",
        dependsOn: ["github-org-membership"],
        waitingOn: null,
      },
      {
        resourceId: "aws-dev",
        displayName: "AWS development account",
        provider: "SERVICENOW",
        decision: "ALLOW",
        reason: "Engineering development cloud access.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONED",
        dependsOn: [],
        waitingOn: null,
      },
      {
        resourceId: "aws-prod",
        displayName: "AWS production account",
        provider: "SERVICENOW",
        decision: "REQUIRES_APPROVAL",
        reason: "Production access requires a human approval.",
        authorization: "AUTHORIZED_BY_APPROVAL",
        status: "PROVISIONED",
        dependsOn: ["aws-dev"],
        waitingOn: null,
      },
    ],
    timeline: [
      { at: t(0), label: "Signed offer received for a cleared candidate", actor: "HR system" },
      { at: t(1), label: "Onboarding started", actor: "Swift" },
      { at: t(2), label: "Suggested 5 tools for the role", actor: "AI" },
      {
        at: t(2),
        label: "Allowed 4 tools; production access needs an approver",
        actor: "Access rules",
      },
      { at: t(3), label: "Asked for approval of production access in ServiceNow", actor: "Swift" },
      { at: t(4), label: "Added to the Okta engineering group", actor: "Swift" },
      { at: t(5), label: "Recorded the new hire's GitHub username", actor: "HR" },
      {
        at: t(6),
        label: "Added to the GitHub organization, then the backend team",
        actor: "Swift",
      },
      { at: t(25), label: "Approved production access in ServiceNow", actor: "Approver" },
      { at: t(25), label: "Confirmed the approval with ServiceNow", actor: "Swift" },
      { at: t(41), label: "Set up both AWS accounts", actor: "IT" },
      { at: t(42), label: "Every tool settled; writing the first-month plan", actor: "Swift" },
      { at: t(43), label: "First-month plan written; onboarding complete", actor: "AI" },
    ],
    plan: {
      summary:
        "Get set up with identity, source control and the development cloud in week one, then ramp into backend delivery with production access used carefully.",
      tasks: [
        {
          phase: "DAY_ONE",
          title: "Sign in with your company identity",
          instruction: "Complete your first sign-in and multi-factor setup.",
          resourceIds: ["okta-engineering-group"],
        },
        {
          phase: "DAY_ONE",
          title: "Accept GitHub access and clone the backend repositories",
          instruction: "Confirm you can see the backend team's repositories.",
          resourceIds: ["github-org-membership", "github-team-backend"],
        },
        {
          phase: "FIRST_WEEK",
          title: "Deploy a small change to the development account",
          instruction: "Use the development cloud account to run and deploy a trivial change.",
          resourceIds: ["aws-dev"],
        },
        {
          phase: "FIRST_WEEK",
          title: "Review production access practices",
          instruction: "Learn when production access is appropriate before you use it.",
          resourceIds: ["aws-prod"],
        },
        {
          phase: "FIRST_30_DAYS",
          title: "Ship a first backend deliverable",
          instruction: "Take a small backlog item through review to production.",
          resourceIds: ["github-team-backend"],
        },
      ],
    },
  },
  {
    slug: "awaiting-approval",
    title: "Contractor waiting on a human approval",
    summary:
      "Production access is refused because they're a contractor. A software license waits for an approver; their other access is already set up.",
    state: "AWAITING_APPROVAL",
    hire: {
      displayName: "Sam Sample",
      jobTitle: "Site Reliability Engineer (contract)",
      department: "Engineering",
      roleFamily: "Site reliability engineer",
      employmentType: "Contractor",
    },
    versions: VERSIONS,
    resources: [
      {
        resourceId: "okta-engineering-group",
        displayName: "Okta engineering group",
        provider: "OKTA",
        decision: "ALLOW",
        reason: "Engineering baseline access.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONED",
        dependsOn: [],
        waitingOn: null,
      },
      {
        resourceId: "cursor-license",
        displayName: "Cursor license",
        provider: "MANUAL",
        decision: "REQUIRES_APPROVAL",
        reason: "Contractor licenses require approval.",
        authorization: "PENDING_APPROVAL",
        status: "AWAITING_APPROVAL",
        dependsOn: [],
        waitingOn: "An approver deciding the ServiceNow approval ticket",
      },
      {
        resourceId: "aws-prod",
        displayName: "AWS production account",
        provider: "SERVICENOW",
        decision: "DENY",
        reason: "Production access is not available to contractors.",
        authorization: "DENIED_BY_POLICY",
        status: "DENIED",
        dependsOn: ["aws-dev"],
        waitingOn: null,
      },
    ],
    timeline: [
      { at: t(0), label: "Signed offer received for a cleared candidate", actor: "HR system" },
      { at: t(1), label: "Onboarding started", actor: "Swift" },
      { at: t(2), label: "Suggested 3 tools for the role", actor: "AI" },
      {
        at: t(2),
        label: "Allowed 1 tool, refused production access, sent the license to an approver",
        actor: "Access rules",
      },
      { at: t(3), label: "Asked for approval of the Cursor license in ServiceNow", actor: "Swift" },
      { at: t(4), label: "Added to the Okta engineering group", actor: "Swift" },
    ],
    plan: null,
  },
  {
    slug: "github-invitation-pending",
    title: "GitHub invitation pending",
    summary:
      "The new hire hasn't accepted their GitHub invitation yet. Their team access waits for it; nothing else is blocked.",
    state: "PROVISIONING",
    hire: {
      displayName: "Riley Placeholder",
      jobTitle: "Frontend Software Engineer",
      department: "Engineering",
      roleFamily: "Software engineer",
      employmentType: "Full time",
    },
    versions: VERSIONS,
    resources: [
      {
        resourceId: "github-org-membership",
        displayName: "GitHub organization membership",
        provider: "GITHUB",
        decision: "ALLOW",
        reason: "Engineering baseline access.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "PROVISIONING",
        dependsOn: [],
        waitingOn: "The employee accepting the organization invitation",
      },
      {
        resourceId: "github-team-frontend",
        displayName: "GitHub frontend team",
        provider: "GITHUB",
        decision: "ALLOW",
        reason: "Engineering team access for software engineers.",
        authorization: "AUTHORIZED_BY_POLICY",
        status: "READY_FOR_PROVISIONING",
        dependsOn: ["github-org-membership"],
        waitingOn: "Its dependency: GitHub organization membership",
      },
    ],
    timeline: [
      { at: t(0), label: "Signed offer received for a cleared candidate", actor: "HR system" },
      { at: t(1), label: "Onboarding started", actor: "Swift" },
      { at: t(2), label: "Suggested 2 tools for the role", actor: "AI" },
      { at: t(2), label: "Allowed both tools", actor: "Access rules" },
      { at: t(3), label: "Waiting for HR to record the GitHub username", actor: "Swift" },
      { at: t(9), label: "Recorded the new hire's GitHub username", actor: "HR" },
      { at: t(10), label: "Sent the GitHub organization invitation", actor: "Swift" },
    ],
    plan: null,
  },
];

/** Validated once at load: an invalid or identifier-bearing scenario fails the build/tests. */
export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze(
  RAW.map((s) => DemoScenarioSchema.parse(s)),
);

/** Exact slug match only; anything else is "not found". */
export function demoScenario(slug: unknown): DemoScenario | null {
  return typeof slug === "string" ? (DEMO_SCENARIOS.find((s) => s.slug === slug) ?? null) : null;
}
