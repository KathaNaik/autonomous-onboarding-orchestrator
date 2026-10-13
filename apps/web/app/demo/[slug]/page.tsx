import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ActorChip,
  BackLink,
  Card,
  DataTable,
  Empty,
  Lifecycle,
  Meta,
  Section,
  StatusBadge,
  TechnicalDetails,
  cx,
  styles as s,
} from "@/components/console/ui";
import { PHASE_LABELS, formatTime, stateLabel, toneOf } from "@/lib/console-model";
import { DEMO_SCENARIOS, demoScenario } from "@/lib/demo-data";
import {
  demoActor,
  demoLifecycle,
  demoStatusSentence,
  demoToolRows,
  demoWhy,
} from "@/lib/demo-model";

/** Only the fixed scenarios exist; any other path segment is a 404 (never a lookup). */
export const dynamicParams = false;
export function generateStaticParams() {
  return DEMO_SCENARIOS.map((x) => ({ slug: x.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const scenario = demoScenario((await params).slug);
  return scenario ? { title: `${scenario.title} · Swift demo`, description: scenario.summary } : {};
}

const PHASES = ["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"] as const;

/** (M10) One synthetic scenario, read-only, laid out like the operator's workflow page. */
export default async function DemoScenarioPage({ params }: { params: Promise<{ slug: string }> }) {
  const scenario = demoScenario((await params).slug);
  if (!scenario) notFound();
  const { hire } = scenario;
  const rows = demoToolRows(scenario);
  const waiting = rows.filter((r) => r.owner && r.owner.label !== "Swift (automatic)");
  return (
    <main className={s.stackMd} style={{ gap: 24 }}>
      <BackLink href="/demo" label="All demo scenarios" />
      <header>
        <h1 className={s.hireName}>
          {hire.displayName}
          <StatusBadge
            tone={toneOf(scenario.state)}
            label={stateLabel(scenario.state)}
            code={scenario.state}
          />
        </h1>
        <div className={s.hireMeta}>
          <span>
            <span style={{ color: "var(--text)" }}>{hire.jobTitle} · </span>
            {hire.department}, {hire.roleFamily}, {hire.employmentType}
          </span>
        </div>
        <p className={s.statusLine}>{demoStatusSentence(scenario, rows)}</p>
        <p className={s.muted} style={{ margin: "8px 0 0", maxWidth: "80ch" }}>
          {scenario.summary}
        </p>
      </header>

      <Card>
        <Lifecycle steps={demoLifecycle(scenario)} />
      </Card>

      {waiting.length > 0 && (
        <Section id="waiting" title="Waiting on">
          <Card>
            <ul className={s.todo}>
              {waiting.map((r) => (
                <li key={r.resource.resourceId} className={s.todoItem}>
                  <div className={s.stack}>
                    <span className={s.primaryText}>
                      {r.owner!.label}: {r.resource.displayName}
                    </span>
                    <span className={s.muted}>{r.note}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className={s.todoFoot}>
              Nothing else is blocked. Swift carries on as soon as they&apos;re done.
            </p>
          </Card>
        </Section>
      )}

      <Section
        id="tools"
        title="Tools and access"
        description="Open “Why” on any row to see what the AI suggested and what the access rules decided."
      >
        <Card>
          <DataTable
            caption="Each tool, its status and who acts next"
            columns={[
              { key: "tool", label: "Tool", primary: true },
              { key: "status", label: "Status" },
              ...(rows.some((r) => r.owner) ? [{ key: "owner", label: "Next step by" }] : []),
              { key: "detail", label: "Details" },
            ]}
            rows={rows.map((r) => ({
              key: r.resource.resourceId,
              cells: {
                tool: <span className={s.primaryText}>{r.resource.displayName}</span>,
                status: <StatusBadge tone={r.tone} label={r.status} code={r.resource.status} />,
                owner: r.owner ? (
                  <span className={cx(s.owner, r.owner.you && s.ownerYou)}>{r.owner.label}</span>
                ) : null,
                detail: (
                  <div className={s.stack}>
                    <span>{r.note}</span>
                    <details className={s.why}>
                      <summary>Why</summary>
                      <div className={s.whyBody}>
                        {demoWhy(r.resource).map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                      </div>
                    </details>
                  </div>
                ),
              },
            }))}
          />
        </Card>
      </Section>

      <Section id="plan" title="First-month plan">
        <Card>
          {!scenario.plan ? (
            <Empty>Not written yet. The plan comes once every tool is set up or settled.</Empty>
          ) : (
            <>
              <p className={s.planSummary}>{scenario.plan.summary}</p>
              {PHASES.map((phase) => {
                const tasks = scenario.plan!.tasks.filter((x) => x.phase === phase);
                return tasks.length === 0 ? null : (
                  <div key={phase} className={s.phase}>
                    <h3 className={s.phaseTitle}>
                      {PHASE_LABELS[phase]}
                      <span className={s.muted} style={{ fontWeight: 400 }}>
                        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                      </span>
                    </h3>
                    <ul className={s.list}>
                      {tasks.map((task) => (
                        <li key={task.title} className={s.task}>
                          <span className={s.taskBox} aria-hidden="true" />
                          <div className={s.stack}>
                            <span className={s.primaryText}>{task.title}</span>
                            <span className={s.muted}>{task.instruction}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </>
          )}
        </Card>
      </Section>

      <Section id="activity" title="Activity">
        <Card>
          <ol className={s.timeline} aria-label="Activity, oldest first">
            {scenario.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className={s.tlItem}>
                <span className={s.tlDot} aria-hidden="true" />
                <div className={s.tlHead}>
                  <span className={s.tlText}>{e.label}</span>
                  <ActorChip actor={demoActor(e.actor)} label={e.actor} />
                </div>
                <time dateTime={e.at} className={s.tlTime}>
                  {formatTime(e.at)}
                </time>
              </li>
            ))}
          </ol>
          <TechnicalDetails summary="Versions used">
            <Meta
              items={[
                ["Tool catalog", scenario.versions.catalog],
                ["Access rules", scenario.versions.policy],
                ["Plan prompt", scenario.versions.prompt],
              ]}
            />
          </TechnicalDetails>
        </Card>
      </Section>
    </main>
  );
}
