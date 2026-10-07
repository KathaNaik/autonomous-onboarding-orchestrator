import Link from "next/link";
import { redirect } from "next/navigation";
import { ConsoleShell } from "@/components/console/shell";
import * as I from "@/components/console/icons";
import { ButtonLink, Callout, Card, PageHeader, cx, styles as s } from "@/components/console/ui";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { STATE_FILTERS, stateLabel } from "@/lib/console-model";
import { fetchWorkflowList, listQuery } from "@/lib/onboarding-read-api";
import { WorkflowTable } from "./workflow-table";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operator console: onboarding workflows. Server-rendered, read-only. */
export default async function OnboardingDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  const params = await searchParams;
  // A full workflow id (search box or the older ?workflowId= lookup) opens it directly.
  const lookup = [params.q, params.workflowId].find((v) => typeof v === "string")?.trim() ?? "";
  if (UUID.test(lookup)) redirect(`/admin/onboarding/${lookup.toLowerCase()}`);
  const query = listQuery({ limit: "25", ...params });
  const state = query.get("state") ?? "";
  const q = query.get("q") ?? "";
  const result = await fetchWorkflowList(query, session);
  if (!result.ok) redirectIfUnauthorized(result.status);

  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(q && { q }), ...(state && { state }), ...next });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    const qs = p.toString();
    return `/admin/onboarding${qs ? `?${qs}` : ""}`;
  };
  const summary = result.ok ? result.body.summary : null;
  const metrics = summary
    ? [
        { label: "Total", value: summary.total, note: "All onboardings" },
        { label: "In progress", value: summary.inProgress, note: "Not yet complete" },
        {
          label: "Needs attention",
          value: summary.needsAttention,
          note: "Waiting on a person or failed",
          alert: summary.needsAttention > 0,
        },
        { label: "Completed", value: summary.completed, note: "Ready for day one" },
      ]
    : [];

  return (
    <ConsoleShell active="workflows" operatorId={session.operatorId}>
      <PageHeader
        title="Onboarding workflows"
        description="Track hires from signed offer through access and onboarding."
        actions={
          <ButtonLink href="/admin/onboarding/new" variant="primary">
            <I.Plus size={14} />
            New onboarding
          </ButtonLink>
        }
      />
      {summary && (
        <section className={s.metrics} aria-label="Summary">
          {metrics.map((m) => (
            <Card key={m.label} className={s.metric}>
              <div className={s.stack}>
                <span className={s.metricLabel}>
                  {m.alert && (
                    <span style={{ color: "var(--amber-fg)", display: "inline-flex" }}>
                      <I.Alert size={14} />
                    </span>
                  )}
                  {m.label}
                </span>
                <span className={s.metricValue}>{m.value}</span>
                <span className={s.metricNote}>{m.note}</span>
              </div>
            </Card>
          ))}
        </section>
      )}
      <Card>
        <div className={s.toolbar}>
          <nav aria-label="Filter by status" className={s.tabs}>
            {[["", "All"] as const, ...STATE_FILTERS.map((v) => [v, stateLabel(v)] as const)].map(
              ([value, label]) => (
                <Link
                  key={value || "all"}
                  href={link({ state: value, cursor: "" })}
                  className={cx(s.tab, state === value && s.tabActive)}
                  aria-current={state === value ? "true" : undefined}
                >
                  {label}
                </Link>
              ),
            )}
          </nav>
          <form method="get" action="/admin/onboarding" className={s.search} role="search">
            {state && <input type="hidden" name="state" value={state} />}
            <label htmlFor="q" className={s.skip}>
              Search by employee or workflow ID
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search employee or workflow ID"
              maxLength={100}
              className={cx(s.input, s.searchInput)}
            />
            <button type="submit" className={cx(s.button, s.secondary)}>
              <I.Search size={14} />
              Search
            </button>
          </form>
        </div>
        {lookup && !q && !UUID.test(lookup) && (
          <div style={{ padding: "12px 24px" }}>
            <Callout tone="amber" title="Not a workflow ID." role="alert" />
          </div>
        )}
        {!result.ok ? (
          <div style={{ padding: "16px 24px" }}>
            <Callout
              tone="red"
              role="alert"
              title={
                result.status === 401 ? "Unauthorized." : "Could not load workflows. Try again."
              }
            />
          </div>
        ) : (
          <>
            <WorkflowTable items={result.body.items} />
            {(query.get("cursor") || result.body.nextCursor) && (
              <div
                className={s.toolbar}
                style={{ borderTop: "1px solid var(--border)", borderBottom: 0 }}
              >
                <span className={cx(s.muted, s.small)} style={{ flex: 1 }}>
                  Showing up to 25 workflows, most recently updated first
                </span>
                {query.get("cursor") && (
                  <ButtonLink href={link({ cursor: "" })} variant="secondary">
                    First page
                  </ButtonLink>
                )}
                {result.body.nextCursor && (
                  <ButtonLink href={link({ cursor: result.body.nextCursor })} variant="secondary">
                    Next page
                  </ButtonLink>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </ConsoleShell>
  );
}
