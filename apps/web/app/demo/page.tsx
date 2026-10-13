import Link from "next/link";
import { PageHeader, StatusBadge, styles as c } from "@/components/console/ui";
import { stateLabel, toneOf } from "@/lib/console-model";
import { DEMO_SCENARIOS } from "@/lib/demo-data";
import styles from "./demo.module.css";

export const dynamic = "force-static";

/** (M10) Public demo index: three fixed synthetic scenarios. */
export default function DemoIndexPage() {
  return (
    <main className={c.stackMd} style={{ gap: 24 }}>
      <PageHeader
        title="Three onboardings, as HR sees them"
        description="Made-up people at different points of an onboarding. Each page shows what the operator sees: who's waiting on what, every tool's status, and why it was allowed."
      />
      <ul className={styles.scenarios}>
        {DEMO_SCENARIOS.map((s) => (
          <li key={s.slug} className={styles.scenario}>
            <StatusBadge tone={toneOf(s.state)} label={stateLabel(s.state)} code={s.state} />
            <div>
              <Link href={`/demo/${s.slug}`} className={styles.scenarioTitle}>
                {s.title}
              </Link>
              <p className={styles.scenarioMeta}>
                {s.hire.displayName} · {s.hire.jobTitle}
              </p>
              <p className={styles.scenarioText}>{s.summary}</p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
