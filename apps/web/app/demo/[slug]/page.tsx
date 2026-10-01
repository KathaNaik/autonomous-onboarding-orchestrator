import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/badge";
import { DEMO_SCENARIOS, demoScenario } from "@/lib/demo-data";
import { AUTH_LABELS, PHASE_LABELS, formatTime, humanize } from "@/lib/dashboard-model";

/** Only the fixed scenarios exist; any other path segment is a 404 (never a lookup). */
export const dynamicParams = false;
export function generateStaticParams() {
  return DEMO_SCENARIOS.map((s) => ({ slug: s.slug }));
}

/** (M10) One synthetic scenario, read-only. */
export default async function DemoScenarioPage({ params }: { params: Promise<{ slug: string }> }) {
  const scenario = demoScenario((await params).slug);
  if (!scenario) notFound();
  const { hire } = scenario;
  return (
    <main>
      <p>
        <Link href="/demo">← All demo scenarios</Link>
      </p>
      <h1>{scenario.title}</h1>
      <p>
        <Badge value={scenario.state} /> {scenario.summary}
      </p>

      <h2>Hire (synthetic)</h2>
      <p>
        {hire.displayName} · {hire.jobTitle} · {hire.department} · {hire.roleFamily} ·{" "}
        {hire.employmentType}
        <br />
        <small>
          Catalog {scenario.versions.catalog} · policy {scenario.versions.policy} · plan prompt{" "}
          {scenario.versions.prompt}
        </small>
      </p>

      <h2>Access: agent recommends, policy authorizes, adapters execute</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Resource</th>
              <th style={th}>Policy decision</th>
              <th style={th}>Authorization</th>
              <th style={th}>Provisioning</th>
              <th style={th}>Waiting on</th>
            </tr>
          </thead>
          <tbody>
            {scenario.resources.map((r) => (
              <tr key={r.resourceId}>
                <td style={td}>
                  {r.displayName}
                  <br />
                  <small>
                    {humanize(r.provider)}
                    {r.dependsOn.length > 0 && ` · depends on ${r.dependsOn.join(", ")}`}
                  </small>
                </td>
                <td style={td}>
                  <Badge value={r.decision} />
                  <br />
                  <small>{r.reason}</small>
                </td>
                <td style={td}>{AUTH_LABELS[r.authorization]}</td>
                <td style={td}>
                  <Badge value={r.status} />
                </td>
                <td style={td}>{r.waitingOn ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Timeline</h2>
      <ol>
        {scenario.timeline.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <small>{formatTime(e.at)}</small> · {e.label} <small>({e.actor})</small>
          </li>
        ))}
      </ol>

      <h2>Onboarding plan</h2>
      {!scenario.plan ? (
        <p>Not reached: the plan is generated only after every resource has settled.</p>
      ) : (
        <>
          <p>{scenario.plan.summary}</p>
          {(["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"] as const).map((phase) => {
            const tasks = scenario.plan!.tasks.filter((x) => x.phase === phase);
            return tasks.length === 0 ? null : (
              <section key={phase}>
                <h3>{PHASE_LABELS[phase]}</h3>
                <ul>
                  {tasks.map((task) => (
                    <li key={task.title}>
                      <strong>{task.title}</strong>: {task.instruction}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}

const table = { borderCollapse: "collapse", width: "100%", minWidth: 640 } as const;
const th = { textAlign: "left", borderBottom: "1px solid #ccc", padding: 6 } as const;
const td = {
  borderBottom: "1px solid #eee",
  padding: 6,
  verticalAlign: "top",
  overflowWrap: "anywhere",
} as const;
