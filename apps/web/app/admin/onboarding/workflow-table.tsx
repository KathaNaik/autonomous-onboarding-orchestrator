import type { WorkflowSummary } from "@aoo/shared";
import Link from "next/link";
import { formatTime, humanize } from "@/lib/dashboard-model";
import { Badge } from "./badge";

/** (M9) Recent workflows (pure; no data fetching). */
export function WorkflowTable({ items }: { items: readonly WorkflowSummary[] }) {
  if (items.length === 0) return <p>No workflows found.</p>;
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          <th>Workflow</th>
          <th>Employee / role</th>
          <th>State</th>
          <th>Resources</th>
          <th>Blockers</th>
          <th>Plan</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => (
          <tr key={w.workflowId} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
            <td>
              <Link href={`/admin/onboarding/${w.workflowId}`}>
                <code>{w.workflowId.slice(0, 8)}…</code>
              </Link>
            </td>
            <td>
              {w.employee.displayName} <small>({w.employee.hrisEmployeeId})</small>
              <br />
              <small>
                {w.employee.facts
                  ? `${humanize(w.employee.facts.departmentCode)} · ${humanize(w.employee.facts.roleFamilyCode)} · ${humanize(w.employee.facts.employmentType)}`
                  : "Facts not available (historical)"}
              </small>
            </td>
            <td>
              <Badge value={w.state} />
            </td>
            <td>
              {w.resourceProgress.total === 0
                ? "None"
                : `${w.resourceProgress.settled}/${w.resourceProgress.total} settled (${w.resourceProgress.provisioned} provisioned, ${w.resourceProgress.denied + w.resourceProgress.rejected} unavailable${w.resourceProgress.failed ? `, ${w.resourceProgress.failed} failed` : ""})`}
            </td>
            <td>
              {w.blockers.length === 0
                ? "—"
                : w.blockers.map((b) => (
                    <div key={b.resourceId}>
                      <code>{b.resourceId}</code>: {b.blocker ?? humanize(b.status)}
                    </div>
                  ))}
            </td>
            <td>
              <Badge value={w.onboardingPlanStatus} label={humanize(w.onboardingPlanStatus)} />
            </td>
            <td>{formatTime(w.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
