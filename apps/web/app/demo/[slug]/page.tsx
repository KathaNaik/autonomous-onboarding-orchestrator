import { notFound } from "next/navigation";
import * as I from "@/components/console/icons";
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
import {
  DECISION_LABELS,
  PHASE_LABELS,
  formatTime,
  providerLabel,
  stateLabel,
  toneOf,
} from "@/lib/console-model";
import { DEMO_SCENARIOS, demoScenario } from "@/lib/demo-data";
import {
  DECISION_TONE,
  demoActor,
  demoLifecycle,
  demoStatusSentence,
  demoToolRows,
} from "@/lib/demo-model";
import styles from "../demo.module.css";

/** Only the fixed scenarios exist; any other path segment is a 404 (never a lookup). */
export const dynamicParams = false;
export function generateStaticParams() {
  return DEMO_SCENARIOS.map((x) => ({ slug: x.slug }));
}

const PHASES = ["DAY_ONE", "FIRST_WEEK", "FIRST_30_DAYS"] as const;

/** (M10) One synthetic scenario, read-only, shown like the operator's workflow page. */
export default async function DemoScenarioPage({ params }: { params: Promise<{ slug: string }> }) {
  const scenario = demoScenario((await params).slug);
  if (!scenario) notFound();
  const { hire } = scenario;
  const rows = demoToolRows(scenario);
  const waiting = rows.filter((r) => r.owner && r.owner.label !== "Swift (automatic)");
  const names = new Map(scenario.resources.map((r) => [r.resourceId, r.displayName]));
  return (
    <main className={s.stackMd} style={{ gap: 24 }}>
      <BackLink href="/demo" label="All demo scenarios" />
      <header>
        <p className={styles.eyebrow}>Demo scenario · {scenario.title}</p>
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

      <Section id="attention" title="Needs attention">
        <Card>
          {waiting.length === 0 ? (
            <p className={s.allClear}>
              <I.Check size={16} />
              {scenario.state === "COMPLETED"
                ? "Onboarding complete. Nothing left to do."
                : "Nothing needs a person right now."}
            </p>
          ) : (
            <ul className={s.todo}>
              {waiting.map((r) => (
                <li key={r.resource.resourceId} className={s.todoItem}>
                  <div className={s.stack}>
                    <span className={s.primaryText}>{r.resource.displayName}</span>
                    <span className={s.owner}>Waiting on: {r.owner!.label}</span>
                    <span className={s.muted}>{r.note}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {waiting.length > 0 && (
            <p className={s.todoFoot}>
              Everything else keeps going: Swift continues automatically when they&apos;re done.
            </p>
          )}
        </Card>
      </Section>

      <Section id="tools" title="Tools and access">
        <Card>
          <DataTable
            caption="Tools and access"
            columns={[
              { key: "tool", label: "Tool", primary: true },
              { key: "status", label: "Status" },
              { key: "owner", label: "Next step by" },
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
                detail: <span>{r.note}</span>,
              },
            }))}
          />
        </Card>
      </Section>

      <Section
        id="decided"
        title="How access was decided"
        description="Each tool is decided on its own: the AI only suggests, deterministic policy authorizes, and Swift sets it up and verifies it with the provider."
      >
        <Card>
          <DataTable
            caption="How access was decided"
            columns={[
              { key: "tool", label: "Tool", primary: true },
              { key: "ai", label: "AI recommends" },
              { key: "policy", label: "Policy authorizes" },
              { key: "run", label: "Swift executes" },
            ]}
            rows={scenario.resources.map((r) => ({
              key: r.resourceId,
              cells: {
                tool: <span className={s.primaryText}>{r.displayName}</span>,
                ai: <ActorChip actor="AI" label="Suggested" />,
                policy: (
                  <span className={s.stack}>
                    <span>
                      <StatusBadge
                        tone={DECISION_TONE[r.decision]}
                        label={DECISION_LABELS[r.decision] ?? r.decision}
                        code={r.decision}
                      />
                    </span>
                    <span className={cx(s.muted, s.small)}>{r.reason}</span>
                  </span>
                ),
                run: (
                  <span className={s.stack}>
                    <span>{providerLabel(r.provider)}</span>
                    {r.dependsOn.some((d) => names.has(d)) && (
                      <span className={cx(s.muted, s.small)}>
                        After{" "}
                        {r.dependsOn
                          .filter((d) => names.has(d))
                          .map((d) => names.get(d))
                          .join(", ")}
                      </span>
                    )}
                  </span>
                ),
              },
            }))}
          />
        </Card>
      </Section>

      <Section id="plan" title="First-month plan" actor={{ kind: "AI", label: "AI" }}>
        <Card>
          {!scenario.plan ? (
            <Empty>
              Not reached yet. The plan is written once every tool is set up or settled.
            </Empty>
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

      <Section id="activity" title="Activity" description="The main steps, oldest first.">
        <Card>
          <ol className={s.timeline} aria-label="Activity timeline">
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
                ["Resource catalog", scenario.versions.catalog],
                ["Access policy", scenario.versions.policy],
                ["Plan prompt", scenario.versions.prompt],
              ]}
            />
          </TechnicalDetails>
        </Card>
      </Section>
    </main>
  );
}
