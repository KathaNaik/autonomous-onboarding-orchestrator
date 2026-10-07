import type { WorkflowSummary } from "@aoo/shared";
import Link from "next/link";
import {
  PLAN_STATUS_LABELS,
  attentionSummary,
  factsLine,
  formatAge,
  formatTime,
  progressLine,
  stateLabel,
  toneOf,
} from "@/lib/console-model";
import { DataTable, Empty, StatusBadge, cx, styles as s } from "@/components/console/ui";

const COLUMNS = [
  { key: "employee", label: "Employee", primary: true },
  { key: "status", label: "Status" },
  { key: "progress", label: "Progress", hideMobile: false },
  { key: "attention", label: "Needs attention" },
  { key: "updated", label: "Updated", hideMobile: true },
  { key: "view", label: "", align: "right" as const, hideMobile: true },
];

/** Recent workflows, phrased for operators (pure; no data fetching). Raw codes stay on detail. */
export function WorkflowTable({ items, now }: { items: readonly WorkflowSummary[]; now?: number }) {
  if (items.length === 0)
    return <Empty>No workflows match. Start one from a signed offer letter.</Empty>;
  return (
    <DataTable
      caption="Onboarding workflows"
      columns={COLUMNS}
      rows={items.map((w) => {
        const href = `/admin/onboarding/${w.workflowId}`;
        const attention = attentionSummary(w.blockers);
        const facts = factsLine(w.employee.facts);
        return {
          key: w.workflowId,
          cells: {
            employee: (
              <div className={s.stack}>
                <Link
                  href={href}
                  className={cx(s.primaryText, s.rowLink)}
                  style={{ color: "inherit" }}
                >
                  {w.employee.displayName || "Unnamed hire"}
                </Link>
                {w.employee.jobTitle && <span>{w.employee.jobTitle}</span>}
                <span className={cx(s.muted, s.small)}>
                  {facts ?? "Facts not recorded (historical)"}
                </span>
              </div>
            ),
            status: (
              <StatusBadge tone={toneOf(w.state)} label={stateLabel(w.state)} code={w.state} />
            ),
            progress: (
              <div className={s.stack}>
                <span className={s.numeric}>{progressLine(w)}</span>
                <span className={cx(s.muted, s.small)}>
                  Plan: {PLAN_STATUS_LABELS[w.onboardingPlanStatus] ?? w.onboardingPlanStatus}
                </span>
              </div>
            ),
            attention:
              w.state === "FAILED" ? (
                <span style={{ color: "var(--red-fg)" }}>Workflow failed</span>
              ) : attention ? (
                <div className={s.stack}>
                  <span
                    style={{
                      color:
                        attention.tone === "red"
                          ? "var(--red-fg)"
                          : attention.tone === "amber"
                            ? "var(--amber-fg)"
                            : "var(--muted)",
                      fontWeight: attention.tone === "gray" ? 400 : 500,
                    }}
                  >
                    {attention.headline}
                  </span>
                  {attention.details.slice(0, 3).map((d) => (
                    <span key={d} className={cx(s.muted, s.small)}>
                      {d}
                    </span>
                  ))}
                </div>
              ) : null,
            updated: (
              <time dateTime={w.updatedAt} title={formatTime(w.updatedAt)} className={s.muted}>
                {formatAge(w.updatedAt, now)}
              </time>
            ),
            view: (
              <Link href={href} aria-label={`View ${w.employee.displayName || "workflow"}`}>
                View
              </Link>
            ),
          },
        };
      })}
    />
  );
}
