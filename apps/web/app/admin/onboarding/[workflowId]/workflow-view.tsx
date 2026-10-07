import type { TimelineEntry, WorkflowObservabilityView } from "@aoo/shared";
import type { ReactNode } from "react";
import {
  AUTHORIZATION_LABELS,
  DECISION_LABELS,
  PHASE_LABELS,
  RESOURCE_STATUS_LABELS,
  actorOf,
  describeBlocker,
  factsLine,
  formatTime,
  humanize,
  lifecycle,
  providerLabel,
  stateLabel,
  timelineSummary,
  toneOf,
  type Tone,
} from "@/lib/console-model";
import {
  ActorChip,
  ButtonLink,
  Callout,
  Card,
  Copy,
  DataTable,
  Empty,
  Lifecycle,
  Meta,
  Meter,
  Mono,
  Section,
  StatusBadge,
  TechnicalDetails,
  cx,
  styles as s,
} from "@/components/console/ui";

type View = WorkflowObservabilityView;
type Resource = View["resources"][number];

const nameOf = (id: string, displayName: string | null | undefined) =>
  displayName ?? humanize(id.replace(/-/g, "_"));

/**
 * One onboarding, explained: who the hire is, where the workflow is, what needs a person, and the
 * chain AI recommends → policy authorizes → the orchestrator executes. Read-only: no forms or
 * buttons; the only actions are links to existing operator pages. Rendered purely from the backend
 * read model; every raw code and identifier stays available under "Technical details".
 */
export function WorkflowView({ view }: { view: View }) {
  const { workflow } = view;
  return (
    <article className={s.stackMd} style={{ gap: 32 }}>
      <HireHeader view={view} />
      <Card>
        <Lifecycle steps={lifecycle(view)} />
      </Card>
      <SummaryCards view={view} />
      <Attention view={view} />
      <RoleAccess view={view} />
      <Policy view={view} />
      <Provisioning view={view} />
      <div className={s.twoCol}>
        <Approvals view={view} />
        <Fulfillments view={view} />
      </div>
      <Plan view={view} />
      <Timeline
        entries={view.timeline}
        names={
          new Map(view.resources.map((r) => [r.resourceId, nameOf(r.resourceId, r.displayName)]))
        }
      />
      <Section
        id="provenance"
        title="Provenance"
        description="Identifiers for tracing this onboarding across the API, worker and providers."
      >
        <Card>
          <TechnicalDetails summary="Show identifiers and traces">
            <Meta
              items={[
                ["Workflow ID", <Copy key="w" value={workflow.workflowId} />],
                ["Workflow state", <Mono key="s">{workflow.state}</Mono>],
                ["Version", String(workflow.version)],
                ["Updated", formatTime(workflow.updatedAt)],
                [
                  "Completed",
                  workflow.completedAt ? formatTime(workflow.completedAt) : "Not reached",
                ],
                ["HRIS employee ID", <Copy key="e" value={view.employee.hrisEmployeeId} />],
                [
                  "HRIS events",
                  view.hrisEvents.length === 0 ? (
                    "Not available"
                  ) : (
                    <span className={s.codeList}>
                      {view.hrisEvents.map((e) => (
                        <span key={e.eventId}>
                          {e.eventType} {e.eventId} · {formatTime(e.receivedAt)}
                        </span>
                      ))}
                    </span>
                  ),
                ],
                ["Correlation IDs", list(view.correlation.correlationIds)],
                [
                  "Trace IDs",
                  view.correlation.traceIds.length
                    ? list(view.correlation.traceIds)
                    : "None recorded (tracing off or historical)",
                ],
                ["Provider correlation keys", list(view.correlation.providerCorrelationKeys)],
              ]}
            />
            {view.correlation.outboxEvents.length > 0 && (
              <Card>
                <DataTable
                  caption="Outbox events"
                  columns={[
                    { key: "type", label: "Outbox event" },
                    { key: "status", label: "Status" },
                    { key: "attempts", label: "Attempts" },
                    { key: "created", label: "Created" },
                    { key: "trace", label: "Trace" },
                  ]}
                  rows={view.correlation.outboxEvents.map((o) => ({
                    key: o.eventId,
                    cells: {
                      type: <Mono>{o.eventType}</Mono>,
                      status: (
                        <StatusBadge
                          tone={toneOf(o.status)}
                          label={humanize(o.status)}
                          code={o.status}
                        />
                      ),
                      attempts: String(o.attempts),
                      created: formatTime(o.createdAt),
                      trace: o.traceId ? <Mono>{o.traceId}</Mono> : "—",
                    },
                  }))}
                />
              </Card>
            )}
            {view.notes.length > 0 && (
              <ul aria-label="Notes" className={s.stack}>
                {view.notes.map((n) => (
                  <li key={n} className={s.muted}>
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </TechnicalDetails>
        </Card>
      </Section>
    </article>
  );
}

const list = (items: string[]) =>
  items.length === 0 ? (
    "—"
  ) : (
    <span className={s.codeList}>
      {items.map((i) => (
        <span key={i}>{i}</span>
      ))}
    </span>
  );

// ---- Header and summary ------------------------------------------------------------------

function HireHeader({ view }: { view: View }) {
  const { workflow, employee } = view;
  const facts = factsLine(employee.facts);
  return (
    <header className={s.hire}>
      <div>
        <h1 className={s.hireName}>
          {employee.displayName}
          <StatusBadge
            tone={toneOf(workflow.state)}
            label={stateLabel(workflow.state)}
            code={workflow.state}
          />
        </h1>
        <div className={s.hireMeta}>
          {employee.jobTitle && <span style={{ color: "var(--text)" }}>{employee.jobTitle}</span>}
          <span>{facts ?? "Canonical facts not available (created before canonical facts)"}</span>
          <span className={s.small}>
            {employee.workEmail} · Started {formatTime(workflow.createdAt)}
          </span>
        </div>
      </div>
      <div className={s.hireId}>
        <span className={cx(s.muted, s.small)}>Workflow</span>
        <Copy value={workflow.workflowId} />
      </div>
    </header>
  );
}

function SummaryCards({ view }: { view: View }) {
  const recommended = view.roleAccessRun?.recommendations.length ?? null;
  const authorized = view.resources.filter((r) =>
    r.authorization.outcome.startsWith("AUTHORIZED"),
  ).length;
  const pending = view.resources.filter(
    (r) => r.authorization.outcome === "PENDING_APPROVAL",
  ).length;
  const notGranted = view.resources.filter((r) =>
    ["DENIED_BY_POLICY", "REJECTED_BY_APPROVER"].includes(r.authorization.outcome),
  ).length;
  const grantable = view.resources.filter((r) => !["DENIED", "REJECTED"].includes(r.status));
  const provisioned = grantable.filter((r) => r.status === "PROVISIONED").length;
  const planStatus = view.onboardingPlan
    ? { tone: "green" as Tone, label: "Accepted", note: `${view.onboardingPlan.taskCount} tasks` }
    : view.onboardingPlanRun
      ? {
          tone: toneOf(view.onboardingPlanRun.status),
          label: humanize(view.onboardingPlanRun.status),
          note: "Generating from settled access",
        }
      : {
          tone: "gray" as Tone,
          label: "Waiting",
          note: "Starts once every resource is settled",
        };
  return (
    <section className={s.summaryGrid} aria-label="At a glance">
      <Card className={s.summaryCard}>
        <div className={s.summaryHead}>
          <span className={s.subTitle}>Access</span>
          <ActorChip actor="AI" label="AI → Policy" />
        </div>
        <span className={s.summaryValue}>
          {recommended === null ? "Not planned yet" : `${recommended} recommended`}
        </span>
        <span className={cx(s.muted, s.small)}>
          {recommended === null
            ? "The Role Access Agent hasn't run."
            : `${authorized} authorized${pending ? `, ${pending} awaiting approval` : ""}${notGranted ? `, ${notGranted} not granted` : ""}`}
        </span>
      </Card>
      <Card className={s.summaryCard}>
        <div className={s.summaryHead}>
          <span className={s.subTitle}>Provisioning</span>
          <ActorChip actor="Worker" label="Orchestrator" />
        </div>
        <span className={s.summaryValue}>
          {grantable.length === 0
            ? "Nothing to provision"
            : `${provisioned} of ${grantable.length} completed`}
        </span>
        {grantable.length > 0 && (
          <div
            className={s.bar}
            role="img"
            aria-label={`${provisioned} of ${grantable.length} resources provisioned`}
          >
            <span
              className={s.barFill}
              style={{ width: `${(provisioned / grantable.length) * 100}%` }}
            />
          </div>
        )}
      </Card>
      <Card className={s.summaryCard}>
        <div className={s.summaryHead}>
          <span className={s.subTitle}>Onboarding plan</span>
          <ActorChip actor="AI" />
        </div>
        <div className={s.cluster}>
          <StatusBadge tone={planStatus.tone} label={planStatus.label} />
        </div>
        <span className={cx(s.muted, s.small)}>{planStatus.note}</span>
      </Card>
    </section>
  );
}

// ---- Needs attention ----------------------------------------------------------------------

function Attention({ view }: { view: View }) {
  const items: ReactNode[] = [];
  const githubPage = `/admin/onboarding/${encodeURIComponent(view.workflow.workflowId)}/github`;
  const names = (rs: Resource[]) => rs.map((r) => nameOf(r.resourceId, r.displayName)).join(", ");
  const by = (pred: (r: Resource) => boolean) => view.resources.filter(pred);

  if (view.workflow.state === "FAILED") {
    items.push(
      <Callout key="failed" tone="red" title="This onboarding stopped" role="alert">
        {view.workflow.failureReason ?? "The workflow failed. See the activity below."}
      </Callout>,
    );
  }
  const github = by((r) => r.blocker === "GITHUB_IDENTITY_CLAIM_REQUIRED");
  if (github.length)
    items.push(
      <Callout
        key="github"
        tone="amber"
        title="GitHub identity required"
        action={
          <ButtonLink href={githubPage} variant="primary">
            Record GitHub username
          </ButtonLink>
        }
      >
        Provisioning is waiting for HR to record the employee&apos;s GitHub username (
        {names(github)}).
      </Callout>,
    );
  const invite = by((r) => r.blocker === "GITHUB_INVITATION_PENDING");
  if (invite.length)
    items.push(
      <Callout key="invite" tone="amber" title="GitHub invitation not accepted yet">
        The employee has a pending invitation to the GitHub organization. Access continues once they
        accept it.
      </Callout>,
    );
  const approval = by((r) => r.status === "AWAITING_APPROVAL");
  if (approval.length)
    items.push(
      <Callout key="approval" tone="amber" title={`Waiting for approval: ${names(approval)}`}>
        Policy requires a human decision in ServiceNow. Other resources continue meanwhile.
      </Callout>,
    );
  const fulfil = by((r) => /^SERVICENOW_FULFILLMENT_/.test(r.blocker ?? ""));
  if (fulfil.length)
    items.push(
      <Callout key="fulfil" tone="amber" title={`Waiting for fulfillment: ${names(fulfil)}`}>
        A fulfiller has to grant this access in ServiceNow. Swift checks the ticket and marks it
        provisioned only when ServiceNow reports it fulfilled.
      </Callout>,
    );
  const manual = by((r) => r.status === "MANUAL_ACTION_REQUIRED");
  if (manual.length)
    items.push(
      <Callout key="manual" tone="amber" title={`Manual setup required: ${names(manual)}`}>
        This resource has no automated provider. An operator confirms it once it&apos;s set up.
      </Callout>,
    );
  const config = by(
    (r) =>
      !["PROVISIONED", "DENIED", "REJECTED", "PROVISIONING_FAILED"].includes(r.status) &&
      r.blockerClass === "DETERMINISTIC_FAILURE",
  );
  if (config.length) {
    const onlyConfig = config.every(
      (r) =>
        r.blocker === "PROVIDER_NOT_CONFIGURED" || /_TARGET_NOT_CONFIGURED$/.test(r.blocker ?? ""),
    );
    items.push(
      <Callout
        key="config"
        tone="amber"
        title={`${onlyConfig ? "Needs configuration" : "Blocked"}: ${names(config)}`}
      >
        {config.map((r) => describeBlocker(r).text).join(". ")}.
        {onlyConfig &&
          " Swift checks again periodically, so it continues once the deployment is configured."}
      </Callout>,
    );
  }
  const failed = by((r) => r.status === "PROVISIONING_FAILED");
  if (failed.length)
    items.push(
      <Callout key="prov-failed" tone="red" title={`Provisioning failed: ${names(failed)}`}>
        The provider reported a permanent failure. The workflow waits until it&apos;s resolved; see
        the resource table for details.
      </Callout>,
    );
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs attention" className={s.stackMd}>
      {items}
    </section>
  );
}

// ---- AI recommends ------------------------------------------------------------------------

function RoleAccess({ view }: { view: View }) {
  const run = view.roleAccessRun;
  return (
    <Section
      id="agent"
      title="Role Access Agent"
      actor={{ kind: "AI", label: "AI" }}
      description="Recommendation only — policy decides authorization."
    >
      <Card>
        {!run ? (
          <Empty>Not reached yet. The agent runs once intake is complete.</Empty>
        ) : (
          <>
            {run.error && (
              <div style={{ padding: "16px 24px 0" }}>
                <Callout tone="red" title="The agent run failed" role="alert">
                  {humanize(run.error.category)}: {run.error.message}
                </Callout>
              </div>
            )}
            {run.recommendations.length === 0 ? (
              <Empty>No resources recommended.</Empty>
            ) : (
              <ul className={s.list} aria-label="Recommendations">
                {run.recommendations.map((r) => (
                  <li key={r.resourceId} className={s.listItem}>
                    <div className={s.stack}>
                      <span className={s.cluster}>
                        <span className={s.primaryText}>{nameOf(r.resourceId, r.displayName)}</span>
                        <span className={s.chip}>{humanize(r.reasonCode)}</span>
                      </span>
                      <span className={s.muted}>{r.reason}</span>
                    </div>
                    <Meter
                      value={r.confidence}
                      label={`Confidence ${Math.round(r.confidence * 100)}%`}
                    />
                  </li>
                ))}
              </ul>
            )}
            <TechnicalDetails>
              <Meta
                items={[
                  ["Run ID", <Copy key="r" value={run.agentRunId} />],
                  ["Status", <Mono key="s">{run.status}</Mono>],
                  ["Model", `${run.modelProvider} / ${run.model}`],
                  ["Served model", run.servedModel ?? "—"],
                  ["Prompt version", <Mono key="p">{run.promptVersion}</Mono>],
                  ["Catalog", <Mono key="c">{`${run.catalogVersion} ${run.catalogHash}`}</Mono>],
                  [
                    "Started → completed",
                    `${formatTime(run.startedAt)} → ${formatTime(run.completedAt)}`,
                  ],
                  ["Latency", run.latencyMs === null ? "—" : `${run.latencyMs} ms`],
                  ["Tokens (in / out)", `${run.inputTokens ?? "—"} / ${run.outputTokens ?? "—"}`],
                  ["Attempts / model calls", `${run.attempts} / ${run.modelCalls ?? "—"}`],
                  ["Other runs", String(run.otherRunCount)],
                  [
                    "Reason codes",
                    <span key="rc" className={s.codeList}>
                      {run.recommendations.map((r) => (
                        <span key={r.resourceId}>
                          {r.resourceId}: {r.reasonCode} ({r.confidence.toFixed(2)})
                        </span>
                      ))}
                    </span>,
                  ],
                ]}
              />
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}

// ---- Policy authorizes --------------------------------------------------------------------

const DECISION_TONE: Record<string, Tone> = {
  ALLOW: "green",
  DENY: "red",
  REQUIRES_APPROVAL: "amber",
};

function Policy({ view }: { view: View }) {
  const ds = view.policyDecisions;
  return (
    <Section
      id="policy"
      title="Policy decisions"
      actor={{ kind: "Policy", label: "Policy" }}
      description="Deterministic authorization from versioned rules. The AI's recommendation is only a request."
    >
      <Card>
        {ds.length === 0 ? (
          <Empty>Not reached yet.</Empty>
        ) : (
          <>
            <ul className={s.list} aria-label="Policy decisions">
              {ds.map((d) => (
                <li key={d.accessDecisionId} className={s.listItem}>
                  <div className={s.stack}>
                    <span className={s.primaryText}>{nameOf(d.resourceId, d.displayName)}</span>
                    <span className={s.muted}>{d.explanation}</span>
                  </div>
                  <StatusBadge
                    tone={DECISION_TONE[d.decision] ?? "gray"}
                    label={DECISION_LABELS[d.decision] ?? humanize(d.decision)}
                    code={d.decision}
                  />
                </li>
              ))}
            </ul>
            <TechnicalDetails>
              <Meta
                items={[
                  ["Policy", <Mono key="p">{`${ds[0]!.policyVersion} ${ds[0]!.policyHash}`}</Mono>],
                  ["Catalog", <Mono key="c">{ds[0]!.catalogVersion}</Mono>],
                  [
                    "Rules",
                    <span key="r" className={s.codeList}>
                      {ds.map((d) => (
                        <span key={d.accessDecisionId}>
                          {d.resourceId}: {d.decision} by {d.matchedRuleId} ({d.reasonCode}) ·{" "}
                          {formatTime(d.decidedAt)}
                        </span>
                      ))}
                    </span>,
                  ],
                ]}
              />
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}

// ---- Orchestrator executes ----------------------------------------------------------------

function waitingOn(r: Resource, all: Resource[]): ReactNode {
  if (r.status === "PROVISIONED")
    return (
      <span className={s.muted}>Done {r.provisionedAt ? formatTime(r.provisionedAt) : ""}</span>
    );
  if (r.status === "DENIED" || r.status === "REJECTED") return <span className={s.muted}>—</span>;
  const lines: string[] = [];
  const unmet = r.dependsOn.filter((d) => d.status !== "PROVISIONED");
  for (const d of unmet) {
    const dep = all.find((x) => x.resourceId === d.resourceId);
    lines.push(
      `${nameOf(d.resourceId, dep?.displayName)}${d.status ? ` (${RESOURCE_STATUS_LABELS[d.status]?.toLowerCase() ?? humanize(d.status).toLowerCase()})` : " (not requested)"}`,
    );
  }
  if (r.blocker && r.blocker !== "DEPENDENCIES_NOT_READY") lines.push(describeBlocker(r).text);
  if (r.status === "AWAITING_APPROVAL" && !r.blocker) lines.push("Approval in ServiceNow");
  if (r.provisioningErrorCode) lines.push(humanize(r.provisioningErrorCode));
  return lines.length ? (
    <div className={s.stack}>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  ) : (
    <span className={s.muted}>—</span>
  );
}

function Provisioning({ view }: { view: View }) {
  const rs = view.resources;
  const hasGitHub = rs.some((r) => r.provider === "GITHUB") || view.githubClaim !== null;
  return (
    <Section
      id="resources"
      title="Resource provisioning"
      actor={{ kind: "Worker", label: "Orchestrator" }}
      description="Each authorized resource is executed independently through its provider, in dependency order."
      aside={
        hasGitHub ? (
          <ButtonLink
            href={`/admin/onboarding/${encodeURIComponent(view.workflow.workflowId)}/github`}
            variant="secondary"
          >
            GitHub account
          </ButtonLink>
        ) : undefined
      }
    >
      <Card>
        {rs.length === 0 ? (
          <Empty>Not reached yet. Resources appear once policy has decided.</Empty>
        ) : (
          <>
            <DataTable
              caption="Resources"
              columns={[
                { key: "resource", label: "Resource" },
                { key: "provider", label: "Provider" },
                { key: "auth", label: "Authorization" },
                { key: "prov", label: "Provisioning" },
                { key: "waiting", label: "Waiting on" },
              ]}
              rows={rs.map((r) => ({
                key: r.accessRequestId,
                cells: {
                  resource: (
                    <span className={s.primaryText}>{nameOf(r.resourceId, r.displayName)}</span>
                  ),
                  provider: providerLabel(r.provider),
                  auth: (
                    <StatusBadge
                      tone={toneOf(r.authorization.outcome)}
                      label={
                        AUTHORIZATION_LABELS[r.authorization.outcome] ??
                        humanize(r.authorization.outcome)
                      }
                      code={r.authorization.outcome}
                    />
                  ),
                  prov:
                    r.status === "DENIED" || r.status === "REJECTED" ? (
                      <span className={s.muted}>Not provisioned</span>
                    ) : (
                      <StatusBadge
                        tone={toneOf(r.status)}
                        label={RESOURCE_STATUS_LABELS[r.status] ?? humanize(r.status)}
                        code={r.status}
                      />
                    ),
                  waiting: waitingOn(r, rs),
                },
              }))}
            />
            <TechnicalDetails>
              {view.provisioningPlan && (
                <Meta
                  items={[
                    ["Provisioning plan", <Copy key="p" value={view.provisioningPlan.planId} />],
                    ["Plan status", <Mono key="s">{view.provisioningPlan.status}</Mono>],
                    ["Created via", <Mono key="v">{view.provisioningPlan.createdVia}</Mono>],
                    [
                      "Catalog / policy",
                      <Mono key="c">
                        {`${view.provisioningPlan.catalogVersion} / ${view.provisioningPlan.policyVersion}`}
                      </Mono>,
                    ],
                    ["Last coordinated", formatTime(view.provisioningPlan.lastCoordinatedAt)],
                    ["Next reconcile", formatTime(view.provisioningPlan.nextReconcileAt)],
                  ]}
                />
              )}
              <div className={s.stackMd}>
                {rs.map((r) => (
                  <div key={r.accessRequestId} className={s.stack}>
                    <span className={s.subTitle} style={{ fontSize: 12 }}>
                      {nameOf(r.resourceId, r.displayName)}
                    </span>
                    <span className={s.codeList}>
                      <span>
                        resource={r.resourceId} request={r.accessRequestId}
                      </span>
                      <span>
                        status={r.status} settled={String(r.settled)} decision=
                        {r.authorization.decision} via={r.authorization.via ?? "—"}
                      </span>
                      {r.blocker && (
                        <span>
                          blocker={r.blocker} class={r.blockerClass ?? "—"}
                        </span>
                      )}
                      {r.providerState && <span>providerState={r.providerState}</span>}
                      {r.provisioningErrorCode && <span>error={r.provisioningErrorCode}</span>}
                      {r.nextReconcileAt && <span>nextReconcile={r.nextReconcileAt}</span>}
                      {r.dependsOn.map((d) => (
                        <span key={d.resourceId}>
                          dependsOn={d.resourceId} ({d.status ?? "not requested"})
                        </span>
                      ))}
                      {Object.entries(r.evidence).map(([k, v]) => (
                        <span key={k}>
                          {k}={String(v)}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
              {view.externalOperations.length > 0 && (
                <Card>
                  <DataTable
                    caption="External operations"
                    columns={[
                      { key: "op", label: "Operation" },
                      { key: "status", label: "Status" },
                      { key: "attempts", label: "Attempts" },
                      { key: "ref", label: "Reference" },
                      { key: "error", label: "Last error" },
                    ]}
                    rows={view.externalOperations.map((o) => ({
                      key: o.operationId,
                      cells: {
                        op: (
                          <span className={s.stack}>
                            <span>
                              {providerLabel(o.provider)} · <Mono>{o.operationType}</Mono>
                            </span>
                            <Mono>{o.operationId}</Mono>
                            {o.resourceId && <span className={s.muted}>{o.resourceId}</span>}
                          </span>
                        ),
                        status: (
                          <StatusBadge
                            tone={toneOf(o.status)}
                            label={humanize(o.status)}
                            code={o.status}
                          />
                        ),
                        attempts: String(o.attempts),
                        ref: o.externalReference ?? "—",
                        error: o.lastError ? <Mono>{o.lastError}</Mono> : "—",
                      },
                    }))}
                  />
                </Card>
              )}
              {(view.identities.length > 0 || view.githubClaim) && (
                <Meta
                  items={[
                    ...view.identities.map(
                      (i) =>
                        [
                          `${providerLabel(i.provider)} identity`,
                          <span key={i.providerSubjectId}>
                            {i.login ?? "—"} <Mono>({i.providerSubjectId})</Mono> · linked{" "}
                            {formatTime(i.linkedAt)}
                          </span>,
                        ] as [string, ReactNode],
                    ),
                    ...(view.githubClaim
                      ? [
                          [
                            "GitHub username (HR)",
                            `${view.githubClaim.login} · ${view.githubClaim.source}${view.githubClaim.recordedBy ? `, by ${view.githubClaim.recordedBy}` : ""}`,
                          ] as [string, ReactNode],
                        ]
                      : []),
                  ]}
                />
              )}
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}

// ---- Humans in the loop -------------------------------------------------------------------

function Approvals({ view }: { view: View }) {
  const names = new Map(view.resources.map((r) => [r.resourceId, r.displayName]));
  return (
    <Section
      id="approvals"
      title="Human approval"
      actor={{ kind: "ServiceNow", label: "ServiceNow" }}
      description="May this resource be granted? Required only where policy says so."
    >
      <Card>
        {view.approvals.length === 0 ? (
          <Empty>No approvals needed.</Empty>
        ) : (
          <>
            <ul className={s.list} aria-label="Approvals">
              {view.approvals.map((a) => (
                <li key={a.approvalId} className={s.listItem}>
                  <div className={s.stack}>
                    <span className={s.primaryText}>
                      {a.resourceId ? nameOf(a.resourceId, names.get(a.resourceId)) : "Resource"}
                    </span>
                    <span className={cx(s.muted, s.small)}>
                      {a.ticketNumber ?? "Ticket pending"}
                      {a.decidedAt ? ` · decided ${formatTime(a.decidedAt)}` : ""}
                    </span>
                  </div>
                  <StatusBadge tone={toneOf(a.status)} label={humanize(a.status)} code={a.status} />
                </li>
              ))}
            </ul>
            <TechnicalDetails>
              <span className={s.codeList}>
                {view.approvals.map((a) => (
                  <span key={a.approvalId}>
                    {a.ticketNumber ?? "—"} sys_id={a.sysId ?? "—"} state={a.providerState ?? "—"}{" "}
                    callbacks=
                    {a.callbacks.received} received/{a.callbacks.processed} processed
                    {a.callbacks.lastOutcome ? ` (last ${a.callbacks.lastOutcome})` : ""} verified=
                    {a.verifiedAt ?? "—"}
                  </span>
                ))}
              </span>
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}

function Fulfillments({ view }: { view: View }) {
  const names = new Map(view.resources.map((r) => [r.resourceId, r.displayName]));
  return (
    <Section
      id="fulfillment"
      title="Human fulfillment"
      actor={{ kind: "ServiceNow", label: "ServiceNow" }}
      description="Has the authorized resource been provisioned? Only a verified “fulfilled” counts."
    >
      <Card>
        {view.fulfillments.length === 0 ? (
          <Empty>No ServiceNow fulfillment for this onboarding.</Empty>
        ) : (
          <>
            <ul className={s.list} aria-label="Fulfillments">
              {view.fulfillments.map((f) => (
                <li key={f.accessRequestId} className={s.listItem}>
                  <div className={s.stack}>
                    <span className={s.primaryText}>
                      {nameOf(f.resourceId, names.get(f.resourceId))}
                    </span>
                    <span className={cx(s.muted, s.small)}>
                      {f.ticketNumber ?? "Ticket not created yet"}
                      {f.verifiedFulfilledAt
                        ? ` · verified ${formatTime(f.verifiedFulfilledAt)}`
                        : ""}
                    </span>
                  </div>
                  <StatusBadge
                    tone={
                      f.verifiedFulfilledAt ? "green" : toneOf(f.fulfillmentState ?? f.localStatus)
                    }
                    label={
                      f.verifiedFulfilledAt
                        ? "Fulfilled"
                        : f.fulfillmentState
                          ? humanize(f.fulfillmentState)
                          : (RESOURCE_STATUS_LABELS[f.localStatus] ?? humanize(f.localStatus))
                    }
                    code={f.fulfillmentState ?? f.localStatus}
                  />
                </li>
              ))}
            </ul>
            <TechnicalDetails>
              <span className={s.codeList}>
                {view.fulfillments.map((f) => (
                  <span key={f.accessRequestId}>
                    {f.ticketNumber ?? "—"} sys_id={f.sysId ?? "—"} request_kind={f.requestKind}{" "}
                    fulfillment_state={f.fulfillmentState ?? "—"} operation=
                    {f.externalOperationId ?? "not created"} ({f.operationStatus ?? "—"}) local=
                    {f.localStatus}
                  </span>
                ))}
              </span>
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}

// ---- Onboarding plan ----------------------------------------------------------------------

function Plan({ view }: { view: View }) {
  const plan = view.onboardingPlan;
  const run = view.onboardingPlanRun;
  return (
    <Section
      id="plan"
      title="Onboarding plan"
      actor={{ kind: "AI", label: "AI" }}
      description="Written from settled access only: it references only resources that were actually provisioned."
    >
      <Card>
        {!plan ? (
          <Empty>
            {run
              ? `No accepted plan yet (${humanize(run.status).toLowerCase()}).`
              : "Not reached yet. The plan is written once every resource is settled."}
          </Empty>
        ) : (
          <>
            <p className={s.planSummary}>{plan.summary}</p>
            {plan.phases.map((p) => (
              <div key={p.phase} className={s.phase}>
                <h3 className={s.phaseTitle}>
                  {PHASE_LABELS[p.phase] ?? humanize(p.phase)}
                  <span className={s.muted} style={{ fontWeight: 400 }}>
                    {p.tasks.length} {p.tasks.length === 1 ? "task" : "tasks"}
                  </span>
                </h3>
                <ul className={s.list}>
                  {p.tasks.map((t, i) => (
                    <li key={i} className={s.task}>
                      <span className={s.taskBox} aria-hidden="true" />
                      <div className={s.stack}>
                        <span className={s.cluster}>
                          <span className={s.primaryText}>{t.title}</span>
                          <span className={s.chip}>{humanize(t.category)}</span>
                        </span>
                        <span className={s.muted}>{t.instruction}</span>
                        {t.resources.length > 0 && (
                          <span className={s.small} style={{ color: "var(--gray-fg)" }}>
                            Uses {t.resources.map((r) => r.displayName ?? r.resourceId).join(", ")}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {(plan || run) && (
          <TechnicalDetails>
            <Meta
              items={[
                ...(plan
                  ? ([
                      ["Plan ID", <Copy key="p" value={plan.planId} />],
                      ["Generated", formatTime(plan.createdAt)],
                      ["Tasks", String(plan.taskCount)],
                    ] as [string, ReactNode][])
                  : []),
                ...(run
                  ? ([
                      ["Run ID", <Copy key="r" value={run.runId} />],
                      ["Run status", <Mono key="s">{run.status}</Mono>],
                      ["Prompt version", <Mono key="pv">{run.promptVersion}</Mono>],
                      ["Served model", run.servedModel ?? "—"],
                      ["Latency", run.latencyMs === null ? "—" : `${run.latencyMs} ms`],
                      [
                        "Tokens (in / out)",
                        `${run.inputTokens ?? "—"} / ${run.outputTokens ?? "—"}`,
                      ],
                      [
                        "Error",
                        run.error
                          ? `${run.error.category}${run.error.retryable === false ? " (permanent)" : ""}`
                          : "—",
                      ],
                    ] as [string, ReactNode][])
                  : []),
              ]}
            />
          </TechnicalDetails>
        )}
      </Card>
    </Section>
  );
}

// ---- Activity -----------------------------------------------------------------------------

function eventTone(e: TimelineEntry): Tone | null {
  if (e.toState) return toneOf(e.toState);
  if (/failed|denied|rejected|conflict/.test(e.type)) return "red";
  if (/provisioned|verified|completed|generated|approved/.test(e.type)) return "green";
  if (/approval_required|manual_action|pending/.test(e.type)) return "amber";
  return null;
}

function Timeline({ entries, names }: { entries: TimelineEntry[]; names: Map<string, string> }) {
  return (
    <Section id="timeline" title="Activity" description="Every recorded step, oldest first.">
      <Card>
        {entries.length === 0 ? (
          <Empty>No activity recorded.</Empty>
        ) : (
          <>
            <ol className={s.timeline} aria-label="Activity timeline">
              {entries.map((e) => {
                const tone = eventTone(e);
                const resource =
                  typeof e.details.resourceId === "string" ? e.details.resourceId : null;
                return (
                  <li key={e.id} className={s.tlItem}>
                    <span
                      className={cx(s.tlDot, tone && tone !== "gray" && s[tone])}
                      aria-hidden="true"
                    />
                    <div className={s.tlHead}>
                      <span className={s.tlText}>{timelineSummary(e)}</span>
                      {resource && (
                        <span className={s.tlSubject}>{names.get(resource) ?? resource}</span>
                      )}
                      <ActorChip actor={actorOf(e)} />
                    </div>
                    <time dateTime={e.occurredAt} className={s.tlTime}>
                      {formatTime(e.occurredAt)}
                    </time>
                  </li>
                );
              })}
            </ol>
            <TechnicalDetails summary="Raw audit records">
              <span className={s.codeList}>
                {entries.map((e) => (
                  <span key={e.id}>
                    {e.occurredAt} {e.type} actor={e.actor ?? "—"}
                    {e.toState ? ` ${e.fromState ?? "—"}→${e.toState}` : ""}
                    {Object.entries(e.details)
                      .map(([k, v]) => ` ${k}=${String(v)}`)
                      .join("")}
                  </span>
                ))}
              </span>
            </TechnicalDetails>
          </>
        )}
      </Card>
    </Section>
  );
}
