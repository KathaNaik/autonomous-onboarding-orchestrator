import type { TimelineEntry, WorkflowObservabilityView } from "@aoo/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AUTHORIZATION_LABELS,
  DECISION_LABELS,
  DETAIL_TABS,
  MANUAL_RESULT_MESSAGES,
  PHASE_LABELS,
  RESOURCE_STATUS_LABELS,
  actorOf,
  describeBlocker,
  factsLine,
  formatTime,
  humanize,
  isKeyEvent,
  lifecycle,
  providerLabel,
  resourceName as nameOf,
  stateLabel,
  statusSentence,
  timelineSummary,
  toneOf,
  toolRows,
  currentApproval,
  formatDate,
  oktaAccount,
  onboardingTiming,
  toolDuration,
  type DetailTab,
  type Tone,
  type ToolRow,
} from "@/lib/console-model";
import * as I from "@/components/console/icons";
import {
  ActorChip,
  Button,
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

/**
 * One onboarding as an HR/IT person needs it: who the hire is, how far along they are, what needs
 * the operator, and one row per tool. The full chain (AI recommends → policy authorizes → the
 * orchestrator executes) with every raw code and identifier lives under "Audit & technical".
 * Rendered purely from the backend read model; the only write is "Mark as done" for tools Swift
 * can't set up automatically (a plain form posting through the web server).
 */
export function WorkflowView({
  view,
  tab = "overview",
  result = null,
}: {
  view: View;
  tab?: DetailTab;
  /** A fixed outcome code from the "Mark as done" handler. */
  result?: string | null;
}) {
  const rows = toolRows(view);
  const message = result ? MANUAL_RESULT_MESSAGES[result] : undefined;
  return (
    <article className={s.stackMd} style={{ gap: 24 }}>
      <HireHeader view={view} rows={rows} />
      <Timing view={view} />
      <Card>
        <Lifecycle steps={lifecycle(view)} />
      </Card>
      <DetailTabs view={view} tab={tab} />
      {message && <Callout tone={message.tone} title={message.text} role="status" />}
      {tab === "overview" && <Overview view={view} rows={rows} />}
      {tab === "plan" && <Plan view={view} />}
      {tab === "activity" && <KeyActivity view={view} />}
      {tab === "technical" && <Technical view={view} />}
    </article>
  );
}

// ---- Header and tabs ----------------------------------------------------------------------

function HireHeader({ view, rows }: { view: View; rows: ToolRow[] }) {
  const { workflow, employee } = view;
  const facts = factsLine(employee.facts);
  return (
    <header>
      <h1 className={s.hireName}>
        {employee.displayName}
        <StatusBadge
          tone={toneOf(workflow.state)}
          label={stateLabel(workflow.state)}
          code={workflow.state}
        />
      </h1>
      <div className={s.hireMeta}>
        <span>
          {employee.jobTitle && (
            <span style={{ color: "var(--text)" }}>{employee.jobTitle} · </span>
          )}
          {facts ?? "Department and role not recorded"}
        </span>
        <span className={s.small}>
          {employee.workEmail} · Started {formatTime(workflow.createdAt)}
        </span>
      </div>
      <p className={s.statusLine}>{statusSentence(view, rows)}</p>
    </header>
  );
}

/** (M14) The start date, highlighted, and how long setting everything up took. */
function Timing({ view }: { view: View }) {
  const t = onboardingTiming(view);
  const done = view.workflow.state === "COMPLETED";
  return (
    <section className={s.timing} aria-label="Start date and timing">
      <Card className={cx(s.metric, s.timingStart)}>
        <div className={s.stack}>
          <span className={s.metricLabel}>Start date</span>
          <span className={s.metricValue}>
            {t.startDate ? formatDate(t.startDate) : "Not recorded"}
          </span>
          <span className={s.metricNote}>
            {t.startDate ? t.startRelative : "The intake didn't include a start date."}
          </span>
          {t.readiness && (
            <span style={{ justifySelf: "start" }}>
              <StatusBadge tone={t.readiness.tone} label={t.readiness.text} />
            </span>
          )}
        </div>
      </Card>
      <Card className={s.metric}>
        <div className={s.stack}>
          <span className={s.metricLabel}>Access set up in</span>
          <span className={s.metricValue}>
            {t.accessDuration ?? (t.elapsed ? "In progress" : "—")}
          </span>
          <span className={s.metricNote}>
            {t.accessReadyAt
              ? `Every tool settled ${formatTime(t.accessReadyAt)}, counted from the start of the onboarding`
              : t.elapsed
                ? `Running for ${t.elapsed}, including time waiting on people`
                : "Not reached"}
          </span>
        </div>
      </Card>
      <Card className={s.metric}>
        <div className={s.stack}>
          <span className={s.metricLabel}>Onboarding complete in</span>
          <span className={s.metricValue}>{t.totalDuration ?? "—"}</span>
          <span className={s.metricNote}>
            {done
              ? "Access set up and the first-month plan written"
              : "Finishes when the first-month plan is written"}
          </span>
        </div>
      </Card>
    </section>
  );
}

function DetailTabs({ view, tab }: { view: View; tab: DetailTab }) {
  const base = `/admin/onboarding/${encodeURIComponent(view.workflow.workflowId)}`;
  const count: Partial<Record<DetailTab, number | undefined>> = {
    plan: view.onboardingPlan?.taskCount,
  };
  return (
    <nav aria-label="Workflow sections" className={s.detailTabs}>
      {DETAIL_TABS.map((t) => (
        <Link
          key={t.id}
          href={t.id === "overview" ? base : `${base}?tab=${t.id}`}
          className={cx(s.detailTab, tab === t.id && s.detailTabActive)}
          aria-current={tab === t.id ? "page" : undefined}
        >
          {t.label}
          {count[t.id] !== undefined && <span className={s.tabCount}>{count[t.id]}</span>}
        </Link>
      ))}
    </nav>
  );
}

// ---- Overview: what needs you, then every tool ---------------------------------------------

function Overview({ view, rows }: { view: View; rows: ToolRow[] }) {
  return (
    <>
      {view.workflow.state === "FAILED" && (
        <Callout tone="red" title="This onboarding stopped" role="alert">
          {view.workflow.failureReason ?? "The workflow failed. See Activity for what happened."}
        </Callout>
      )}
      <ToDo view={view} rows={rows} />
      <Tools view={view} rows={rows} />
    </>
  );
}

const GITHUB_FIX = new Set(["GITHUB_IDENTITY_NOT_FOUND", "GITHUB_IDENTITY_CONFLICT"]);

function ToDo({ view, rows }: { view: View; rows: ToolRow[] }) {
  const wf = encodeURIComponent(view.workflow.workflowId);
  const githubPage = `/admin/onboarding/${wf}/github`;
  const names = (rs: ToolRow[]) => rs.map((r) => r.name).join(", ");
  const items: ReactNode[] = [];

  const claim = rows.filter((r) => r.resource.blocker === "GITHUB_IDENTITY_CLAIM_REQUIRED");
  if (claim.length)
    items.push(
      <li key="github" className={s.todoItem}>
        <div className={s.todoHead}>
          <div className={s.stack}>
            <span className={s.primaryText}>Record the employee&apos;s GitHub username</span>
            <span className={s.muted}>Needed before Swift can set up {names(claim)}.</span>
          </div>
          <ButtonLink href={githubPage} variant="primary">
            Record GitHub username
          </ButtonLink>
        </div>
      </li>,
    );
  const fix = rows.filter((r) => GITHUB_FIX.has(r.resource.blocker ?? ""));
  if (fix.length)
    items.push(
      <li key="github-fix" className={s.todoItem}>
        <div className={s.todoHead}>
          <div className={s.stack}>
            <span className={s.primaryText}>Check the GitHub username</span>
            <span className={s.muted}>{fix[0]!.note}</span>
          </div>
          <ButtonLink href={githubPage} variant="primary">
            Fix GitHub username
          </ButtonLink>
        </div>
      </li>,
    );
  for (const r of rows.filter((x) => x.resource.status === "MANUAL_ACTION_REQUIRED")) {
    const id = `evidence-${r.resource.accessRequestId}`;
    items.push(
      <li key={r.resource.accessRequestId} className={s.todoItem}>
        <div className={s.stack}>
          <span className={s.primaryText}>Set up {r.name}</span>
          <span className={s.muted}>
            Swift can&apos;t set this tool up automatically. Set it up for the employee, then mark
            it as done.
          </span>
        </div>
        <form
          method="post"
          action={`/admin/onboarding/${wf}/resources/${encodeURIComponent(r.resource.accessRequestId)}/complete`}
          className={s.todoForm}
        >
          <label className={s.label} htmlFor={id}>
            How was it set up?
          </label>
          <textarea
            id={id}
            name="evidence"
            className={s.textarea}
            required
            minLength={8}
            maxLength={500}
            placeholder="For example: license assigned in the vendor's admin console"
            aria-describedby={`${id}-hint`}
          />
          <p className={s.hint} id={`${id}-hint`}>
            Saved in the audit record. Don&apos;t include passwords or keys.
          </p>
          <div>
            <Button variant="primary">Mark as done</Button>
          </div>
        </form>
      </li>,
    );
  }
  for (const r of rows.filter((x) => x.resource.status === "PROVISIONING_FAILED")) {
    items.push(
      <li key={`retry-${r.resource.accessRequestId}`} className={s.todoItem}>
        <div className={s.todoHead}>
          <div className={s.stack}>
            <span className={s.primaryText}>Retry {r.name}</span>
            <span className={s.muted}>
              {r.note} Once the cause is fixed (for example a reconnected system), retry: Swift
              starts the setup again with fresh requests.
            </span>
          </div>
          <form
            method="post"
            action={`/admin/onboarding/${wf}/resources/${encodeURIComponent(r.resource.accessRequestId)}/retry`}
          >
            <Button variant="primary">Retry</Button>
          </form>
        </div>
      </li>,
    );
  }
  const admin = rows.filter(
    (r) => r.owner && !r.owner.you && r.owner.label.startsWith("Swift admin"),
  );
  if (admin.length)
    items.push(
      <li key="admin" className={s.todoItem}>
        <div className={s.stack}>
          <span className={s.primaryText}>Tell your Swift administrator</span>
          {admin.map((r) => (
            <span key={r.resource.accessRequestId} className={s.muted}>
              {r.name}: {r.note}
            </span>
          ))}
        </div>
      </li>,
    );

  const waiting = rows.filter((r) => r.owner && !r.owner.you && !r.owner.label.startsWith("Swift"));
  const done = view.workflow.state === "COMPLETED";
  return (
    <Section id="todo" title="Needs your attention">
      <Card>
        {items.length > 0 ? (
          <ul className={s.todo}>{items}</ul>
        ) : (
          <p className={s.allClear}>
            <I.Check size={16} />
            {done ? "Onboarding complete. Nothing left to do." : "Nothing needs you right now."}
          </p>
        )}
        {waiting.length > 0 && (
          <p className={s.todoFoot}>
            Waiting on others:{" "}
            {waiting
              .map((r) => `${r.name} (${r.owner!.label}${r.ticket ? `, ${r.ticket}` : ""})`)
              .join("; ")}
            . Swift continues automatically when they&apos;re done.
          </p>
        )}
      </Card>
    </Section>
  );
}

function Tools({ view, rows }: { view: View; rows: ToolRow[] }) {
  const hasGitHub =
    view.resources.some((r) => r.provider === "GITHUB") || view.githubClaim !== null;
  const recommended = view.roleAccessRun?.recommendations ?? [];
  return (
    <Section
      id="tools"
      title="Tools and access"
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
        {rows.length === 0 ? (
          <Empty>
            {recommended.length > 0
              ? `Checking which of the ${recommended.length} suggested tools this person is allowed.`
              : "Not reached yet. Swift works out which tools this person needs once intake is complete."}
          </Empty>
        ) : (
          <DataTable
            caption="Tools and access"
            columns={[
              { key: "tool", label: "Tool", primary: true },
              { key: "status", label: "Status" },
              { key: "owner", label: "Next step by" },
              { key: "detail", label: "Details" },
            ]}
            rows={rows.map((r) => ({
              key: r.resource.accessRequestId,
              cells: {
                tool: <span className={s.primaryText}>{r.name}</span>,
                status: <StatusBadge tone={r.tone} label={r.status} code={r.resource.status} />,
                owner: r.owner ? (
                  <span className={cx(s.owner, r.owner.you && s.ownerYou)}>{r.owner.label}</span>
                ) : null,
                detail: <ToolDetail row={r} view={view} />,
              },
            }))}
          />
        )}
      </Card>
    </Section>
  );
}

function ToolDetail({ row, view }: { row: ToolRow; view: View }) {
  const id = row.resource.resourceId;
  const reason = view.roleAccessRun?.recommendations.find((x) => x.resourceId === id)?.reason;
  const decision = view.policyDecisions.find((d) => d.resourceId === id);
  const approval = currentApproval(view, id);
  const why: string[] = [];
  if (reason) why.push(`Suggested by AI: ${reason}`);
  if (decision)
    why.push(
      decision.decision === "REQUIRES_APPROVAL"
        ? `Policy: needs approval. ${decision.explanation}`
        : `Policy: ${(DECISION_LABELS[decision.decision] ?? humanize(decision.decision)).toLowerCase()}. ${decision.explanation}`,
    );
  if (approval?.decidedAt)
    why.push(`${humanize(approval.status)} in ServiceNow ${formatTime(approval.decidedAt)}.`);
  const okta = row.resource.provider === "OKTA" ? oktaAccount(view) : null;
  const took = toolDuration(row.resource, view);
  return (
    <div className={s.stack}>
      {row.note && <span>{row.note}</span>}
      {took && row.resource.status === "PROVISIONED" && (
        <span className={cx(s.muted, s.small)}>Ready {took} after the onboarding started</span>
      )}
      {okta && (
        <span className={s.small}>
          Okta login: <span className={s.mono}>{okta.login}</span>
          <span className={s.muted}> · {okta.note}</span>
        </span>
      )}
      {row.ticket && <span className={cx(s.muted, s.small)}>ServiceNow {row.ticket}</span>}
      {why.length > 0 && (
        <details className={s.why}>
          <summary>Why</summary>
          <div className={s.whyBody}>
            {why.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </details>
      )}
      {row.resource.status === "AWAITING_APPROVAL" && approval && (
        <details className={s.why}>
          <summary>Ticket missing in ServiceNow?</summary>
          <div className={s.whyBody}>
            <span>
              If {approval.ticketNumber} no longer exists (for example the ServiceNow instance was
              replaced), ask for a new one. Swift checks ServiceNow first and changes nothing while
              the old ticket still exists. The new ticket still needs an approver.
            </span>
            <form
              method="post"
              action={`/admin/onboarding/${encodeURIComponent(view.workflow.workflowId)}/resources/${encodeURIComponent(row.resource.accessRequestId)}/request-approval`}
            >
              <Button variant="secondary">Request approval again</Button>
            </form>
          </div>
        </details>
      )}
    </div>
  );
}

// ---- Activity: the main steps only ---------------------------------------------------------

function KeyActivity({ view }: { view: View }) {
  const entries = view.timeline.filter(isKeyEvent);
  const names = new Map(
    view.resources.map((r) => [r.resourceId, nameOf(r.resourceId, r.displayName)]),
  );
  return (
    <Section
      id="timeline"
      title="Activity"
      description={
        <>
          The main steps, oldest first. Every recorded event is under{" "}
          <Link
            href={`/admin/onboarding/${encodeURIComponent(view.workflow.workflowId)}?tab=technical`}
          >
            Audit &amp; technical
          </Link>
          .
        </>
      }
    >
      <Card>
        {entries.length === 0 ? (
          <Empty>No activity recorded.</Empty>
        ) : (
          <TimelineList entries={entries} names={names} />
        )}
      </Card>
    </Section>
  );
}

// ---- Audit & technical: the full chain, for engineers and auditors --------------------------

function Technical({ view }: { view: View }) {
  return (
    <>
      <p className={s.muted} style={{ margin: 0 }}>
        How each decision was made, with the identifiers needed to trace it. AI recommends, policy
        authorizes, and Swift executes and verifies.
      </p>
      <RoleAccess view={view} />
      <Policy view={view} />
      <Provisioning view={view} />
      <div className={s.twoCol}>
        <Approvals view={view} />
        <Fulfillments view={view} />
      </div>
      <PlanProvenance view={view} />
      <Timeline
        entries={view.timeline}
        names={
          new Map(view.resources.map((r) => [r.resourceId, nameOf(r.resourceId, r.displayName)]))
        }
      />
      <Provenance view={view} />
    </>
  );
}

function Provenance({ view }: { view: View }) {
  const { workflow } = view;
  return (
    <Section id="provenance" title="Provenance">
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
  return (
    <Section
      id="resources"
      title="Resource provisioning"
      actor={{ kind: "Worker", label: "Orchestrator" }}
      description="Each authorized resource is executed independently through its provider, in dependency order."
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
      title="First-month plan"
      actor={{ kind: "AI", label: "AI" }}
      description="A checklist for the employee's first month, written from the tools they actually have."
    >
      <Card>
        {!plan ? (
          <Empty>
            {run?.status === "FAILED"
              ? "The plan couldn't be written. Tell your Swift administrator."
              : run
                ? "Writing the plan now."
                : "Not reached yet. The plan is written once every tool is set up or settled."}
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
                        <span className={s.primaryText}>{t.title}</span>
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
      </Card>
    </Section>
  );
}

function PlanProvenance({ view }: { view: View }) {
  const plan = view.onboardingPlan;
  const run = view.onboardingPlanRun;
  return (
    <Section
      id="plan-run"
      title="Onboarding Plan Agent"
      actor={{ kind: "AI", label: "AI" }}
      description="Written from settled access only: it references only resources that were actually provisioned."
    >
      <Card>
        {!plan && !run ? (
          <Empty>Not reached yet.</Empty>
        ) : (
          <TechnicalDetails>
            <Meta
              items={[
                ...(plan
                  ? ([
                      ["Plan ID", <Copy key="p" value={plan.planId} />],
                      ["Generated", formatTime(plan.createdAt)],
                      ["Tasks", String(plan.taskCount)],
                      [
                        "Task categories",
                        <span key="c" className={s.codeList}>
                          {plan.phases.flatMap((p) =>
                            p.tasks.map((t, i) => (
                              <span key={`${p.phase}-${i}`}>
                                {p.phase} {t.category}: {t.title}
                              </span>
                            )),
                          )}
                        </span>,
                      ],
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
    <Section
      id="audit"
      title="Full activity record"
      description="Every recorded event, oldest first."
    >
      <Card>
        {entries.length === 0 ? (
          <Empty>No activity recorded.</Empty>
        ) : (
          <>
            <TimelineList entries={entries} names={names} />
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

function TimelineList({
  entries,
  names,
}: {
  entries: TimelineEntry[];
  names: Map<string, string>;
}) {
  return (
    <ol className={s.timeline} aria-label="Activity timeline">
      {entries.map((e) => {
        const tone = eventTone(e);
        const resource = typeof e.details.resourceId === "string" ? e.details.resourceId : null;
        return (
          <li key={e.id} className={s.tlItem}>
            <span className={cx(s.tlDot, tone && tone !== "gray" && s[tone])} aria-hidden="true" />
            <div className={s.tlHead}>
              <span className={s.tlText}>{timelineSummary(e)}</span>
              {resource && <span className={s.tlSubject}>{names.get(resource) ?? resource}</span>}
              <ActorChip actor={actorOf(e)} />
            </div>
            <time dateTime={e.occurredAt} className={s.tlTime}>
              {formatTime(e.occurredAt)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
