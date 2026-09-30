import type { WorkflowObservabilityView } from "@aoo/shared";
import type { ReactNode } from "react";
import { AUTH_LABELS, PHASE_LABELS, formatTime, humanize } from "@/lib/dashboard-model";
import { Badge } from "../badge";

/**
 * (M9) The complete, read-only lifecycle of one workflow, rendered purely from the backend read
 * model (no business reconstruction here, no mutation controls). Missing later-milestone data
 * shows "Not reached" / "Not available" instead of failing.
 */
export function WorkflowView({ view }: { view: WorkflowObservabilityView }) {
  const { workflow, employee } = view;
  return (
    <article>
      <Section id="overview" title="1. Overview">
        <dl style={dl}>
          <Item k="Workflow">
            <code>{workflow.workflowId}</code> <Badge value={workflow.state} />
          </Item>
          <Item k="Employee">
            {employee.displayName}{" "}
            <small>
              ({employee.hrisEmployeeId}, {employee.workEmail})
            </small>
          </Item>
          <Item k="Job title">{employee.jobTitle ?? "Not available"}</Item>
          <Item k="Facts">
            {employee.facts
              ? `${humanize(employee.facts.departmentCode)} · ${humanize(employee.facts.roleFamilyCode)} · ${humanize(employee.facts.employmentType)}`
              : "Not available (created before canonical facts)"}
          </Item>
          <Item k="Created / updated">
            {formatTime(workflow.createdAt)} / {formatTime(workflow.updatedAt)}
          </Item>
          <Item k="Completed">
            {workflow.completedAt ? formatTime(workflow.completedAt) : "Not reached"}
          </Item>
          {workflow.failureReason && <Item k="Failure reason">{workflow.failureReason}</Item>}
          <Item k="HRIS events">
            {view.hrisEvents.length === 0
              ? "Not available"
              : view.hrisEvents
                  .map((e) => `${e.eventType} (${formatTime(e.receivedAt)})`)
                  .join(", ")}
          </Item>
        </dl>
        {view.notes.length > 0 && (
          <ul aria-label="notes">
            {view.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="agent" title="2. Role Access Agent (recommendations: not authorization)">
        {!view.roleAccessRun ? (
          <p>Not reached.</p>
        ) : (
          <>
            <p>
              Run <code>{view.roleAccessRun.agentRunId}</code>{" "}
              <Badge value={view.roleAccessRun.status} /> · prompt{" "}
              {view.roleAccessRun.promptVersion} · model {view.roleAccessRun.model}
              {view.roleAccessRun.servedModel
                ? ` (served ${view.roleAccessRun.servedModel})`
                : ""}{" "}
              · catalog {view.roleAccessRun.catalogVersion} ·{" "}
              {formatTime(view.roleAccessRun.startedAt)} →{" "}
              {formatTime(view.roleAccessRun.completedAt)} · {view.roleAccessRun.latencyMs ?? "—"}{" "}
              ms · tokens {view.roleAccessRun.inputTokens ?? "—"}/
              {view.roleAccessRun.outputTokens ?? "—"}
              {view.roleAccessRun.otherRunCount > 0 &&
                ` · ${view.roleAccessRun.otherRunCount} other run(s)`}
            </p>
            {view.roleAccessRun.error && (
              <p role="alert">
                Error: {view.roleAccessRun.error.category} — {view.roleAccessRun.error.message}
              </p>
            )}
            <Table
              head={["Resource", "Reason code", "Reason", "Confidence"]}
              rows={view.roleAccessRun.recommendations.map((r) => [
                <ResourceName key="r" id={r.resourceId} name={r.displayName} />,
                r.reasonCode,
                r.reason,
                r.confidence.toFixed(2),
              ])}
              empty="No resources recommended."
            />
          </>
        )}
      </Section>

      <Section id="policy" title="3. Policy decisions (authorization)">
        <Table
          head={["Resource", "Decision", "Rule", "Reason", "Policy", "Decided"]}
          rows={view.policyDecisions.map((d) => [
            <ResourceName key="r" id={d.resourceId} name={d.displayName} />,
            <Badge key="d" value={d.decision} />,
            <code key="rule">{d.matchedRuleId}</code>,
            `${d.reasonCode}: ${d.explanation}`,
            <span key="p">
              {d.policyVersion}{" "}
              <small>
                <code>{d.policyHash.slice(0, 19)}…</code>
              </small>
            </span>,
            formatTime(d.decidedAt),
          ])}
          empty="Not reached."
        />
      </Section>

      <Section id="resources" title="4. Resources and provisioning">
        {view.provisioningPlan ? (
          <p>
            Provisioning plan <code>{view.provisioningPlan.planId}</code>{" "}
            <Badge value={view.provisioningPlan.status} /> · catalog{" "}
            {view.provisioningPlan.catalogVersion} · policy {view.provisioningPlan.policyVersion} ·
            last coordinated {formatTime(view.provisioningPlan.lastCoordinatedAt)}
          </p>
        ) : (
          <p>Provisioning plan: not reached.</p>
        )}
        <Table
          head={[
            "Resource",
            "Provider",
            "Authorization",
            "Provisioning",
            "Depends on",
            "Blocker",
            "Provider state",
            "Next reconcile",
            "Evidence",
          ]}
          rows={view.resources.map((r) => [
            <ResourceName key="r" id={r.resourceId} name={r.displayName} />,
            r.provider ?? "Not available",
            <Badge
              key="a"
              value={r.authorization.outcome}
              label={AUTH_LABELS[r.authorization.outcome]}
            />,
            <span key="s">
              <Badge value={r.status} /> {r.settled ? "(settled)" : "(unsettled)"}
              {r.provisioningErrorCode && <div>Error: {r.provisioningErrorCode}</div>}
            </span>,
            r.dependsOn.length === 0
              ? "—"
              : r.dependsOn.map((d) => (
                  <div key={d.resourceId}>
                    depends on <code>{d.resourceId}</code> (
                    {d.status ? humanize(d.status) : "not requested"})
                  </div>
                )),
            r.blocker ? `${r.blocker} (${humanize(r.blockerClass)})` : "—",
            r.providerState ?? "—",
            formatTime(r.nextReconcileAt),
            <Details key="e" details={r.evidence} />,
          ])}
          empty="Not reached."
        />
      </Section>

      <Section id="servicenow" title="5. ServiceNow approvals and fulfillment">
        <h3>Approvals (may this resource be granted?)</h3>
        <Table
          head={[
            "Resource",
            "Ticket",
            "sys_id",
            "Status",
            "Provider state",
            "Verified",
            "Callbacks",
          ]}
          rows={view.approvals.map((a) => [
            a.resourceId ? <code key="r">{a.resourceId}</code> : "—",
            a.ticketNumber ?? "—",
            a.sysId ? <code key="s">{a.sysId}</code> : "—",
            <Badge key="st" value={a.status} />,
            a.providerState ?? "—",
            formatTime(a.verifiedAt),
            `${a.callbacks.received} received, ${a.callbacks.processed} processed${a.callbacks.lastOutcome ? ` (last: ${a.callbacks.lastOutcome})` : ""}`,
          ])}
          empty="No approval tickets."
        />
        <h3>
          Fulfillment (ticket created ≠ provisioned; only a verified “fulfilled” read-back
          provisions)
        </h3>
        <Table
          head={[
            "Resource",
            "Ticket",
            "sys_id",
            "request_kind",
            "fulfillment_state",
            "Operation",
            "Verified fulfilled",
            "Local state",
          ]}
          rows={view.fulfillments.map((f) => [
            <code key="r">{f.resourceId}</code>,
            f.ticketNumber ?? "—",
            f.sysId ? <code key="s">{f.sysId}</code> : "—",
            f.requestKind,
            f.fulfillmentState ?? "—",
            f.externalOperationId ? (
              <code key="o">
                {f.externalOperationId.slice(0, 8)}… ({f.operationStatus})
              </code>
            ) : (
              "Not created"
            ),
            formatTime(f.verifiedFulfilledAt),
            <Badge key="l" value={f.localStatus} />,
          ])}
          empty="No ServiceNow fulfillment."
        />
      </Section>

      <Section id="operations" title="6. External operations and identities">
        <Table
          head={[
            "Operation",
            "Provider",
            "Type",
            "Status",
            "Attempts",
            "Resource",
            "Reference",
            "Updated",
            "Last error",
          ]}
          rows={view.externalOperations.map((o) => [
            <code key="id" title={o.keySummary}>
              {o.operationId.slice(0, 8)}…
            </code>,
            o.provider,
            o.operationType,
            <Badge key="s" value={o.status} />,
            String(o.attempts),
            o.resourceId ? <code key="r">{o.resourceId}</code> : "—",
            o.externalReference ?? "—",
            formatTime(o.updatedAt),
            o.lastError ?? "—",
          ])}
          empty="No external operations."
        />
        <Table
          head={["Identity provider", "Subject id", "Login", "Linked", "Verified"]}
          rows={view.identities.map((i) => [
            i.provider,
            <code key="s">{i.providerSubjectId}</code>,
            i.login ?? "—",
            formatTime(i.linkedAt),
            formatTime(i.verifiedAt),
          ])}
          empty="No linked identities."
        />
        {view.githubClaim && (
          <p>
            GitHub username recorded by HR: <code>{view.githubClaim.login}</code> (
            {view.githubClaim.source}
            {view.githubClaim.recordedBy ? `, by ${view.githubClaim.recordedBy}` : ""})
          </p>
        )}
      </Section>

      <Section id="plan" title="7. Onboarding plan">
        {view.onboardingPlanRun && (
          <p>
            Run <code>{view.onboardingPlanRun.runId}</code>{" "}
            <Badge value={view.onboardingPlanRun.status} /> · prompt{" "}
            {view.onboardingPlanRun.promptVersion} · served{" "}
            {view.onboardingPlanRun.servedModel ?? "—"} · {view.onboardingPlanRun.latencyMs ?? "—"}{" "}
            ms · tokens {view.onboardingPlanRun.inputTokens ?? "—"}/
            {view.onboardingPlanRun.outputTokens ?? "—"}
            {view.onboardingPlanRun.error &&
              ` · error ${view.onboardingPlanRun.error.category}${view.onboardingPlanRun.error.retryable === false ? " (permanent)" : ""}`}
          </p>
        )}
        {!view.onboardingPlan ? (
          <p>{view.onboardingPlanRun ? "No accepted plan." : "Not reached."}</p>
        ) : (
          <>
            <p>
              Plan <code>{view.onboardingPlan.planId}</code> · generated{" "}
              {formatTime(view.onboardingPlan.createdAt)} · {view.onboardingPlan.taskCount} tasks
            </p>
            <p>
              <strong>{view.onboardingPlan.summary}</strong>
            </p>
            {view.onboardingPlan.phases.map((p) => (
              <div key={p.phase}>
                <h3>{PHASE_LABELS[p.phase] ?? humanize(p.phase)}</h3>
                <ol>
                  {p.tasks.map((t, i) => (
                    <li key={i}>
                      <strong>{t.title}</strong> <small>[{humanize(t.category)}]</small>
                      <div>{t.instruction}</div>
                      {t.resources.length > 0 && (
                        <small>
                          Resources:{" "}
                          {t.resources.map((r) => r.displayName ?? r.resourceId).join(", ")}
                        </small>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section id="timeline" title="8. Timeline">
        <Table
          head={["When", "Event", "Actor", "State", "Details"]}
          rows={view.timeline.map((e) => [
            formatTime(e.occurredAt),
            <span key="l">
              {e.label}{" "}
              <small>
                <code>{e.type}</code>
              </small>
            </span>,
            e.actor ?? "—",
            e.toState ? `${e.fromState ?? "—"} → ${e.toState}` : "—",
            <Details key="d" details={e.details} />,
          ])}
          empty="No events."
        />
      </Section>

      <Section id="correlation" title="9. Trace and correlation">
        <dl style={dl}>
          <Item k="Correlation ids">{view.correlation.correlationIds.join(", ") || "—"}</Item>
          <Item k="Trace ids">
            {view.correlation.traceIds.join(", ") || "None recorded (tracing off or historical)"}
          </Item>
          <Item k="Provider correlation keys">
            {view.correlation.providerCorrelationKeys.join(", ") || "—"}
          </Item>
        </dl>
        <Table
          head={["Outbox event", "Type", "Status", "Attempts", "Created", "Published", "Trace"]}
          rows={view.correlation.outboxEvents.map((o) => [
            <code key="i">{o.eventId.slice(0, 8)}…</code>,
            o.eventType,
            <Badge key="s" value={o.status} />,
            String(o.attempts),
            formatTime(o.createdAt),
            formatTime(o.publishedAt),
            o.traceId ? <code key="t">{o.traceId}</code> : "—",
          ])}
          empty="No outbox events."
        />
      </Section>
    </article>
  );
}

const dl = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px" } as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} style={{ margin: "20px 0" }}>
      <h2 id={`${id}-title`} style={{ fontSize: 18, borderBottom: "1px solid #ddd" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ fontWeight: 600 }}>{k}</dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </>
  );
}

function ResourceName({ id, name }: { id: string; name: string | null }) {
  return (
    <span>
      {name ?? id}{" "}
      <small>
        <code>{id}</code>
      </small>
    </span>
  );
}

function Details({ details }: { details: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(details);
  if (entries.length === 0) return <>—</>;
  return (
    <small>
      {entries.map(([k, v]) => (
        <span key={k} style={{ display: "block" }}>
          {k}=<code>{String(v)}</code>
        </span>
      ))}
    </small>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p>{empty}</p>;
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, margin: "6px 0" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
            {cells.map((c, j) => (
              <td key={j} style={{ padding: "3px 6px 3px 0", overflowWrap: "anywhere" }}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
