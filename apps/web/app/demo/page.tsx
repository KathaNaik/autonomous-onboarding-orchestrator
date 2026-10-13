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
        title="Onboarding demo"
        description="Three example onboardings with made-up people, shown the way an HR or IT operator sees them in Swift. Nothing here calls ServiceNow, Okta, GitHub or OpenAI."
      />
      <ul className={styles.cards} style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {DEMO_SCENARIOS.map((s) => (
          <li key={s.slug} className={styles.card}>
            <div>
              <StatusBadge tone={toneOf(s.state)} label={stateLabel(s.state)} code={s.state} />
            </div>
            <h2 className={styles.cardTitle}>{s.title}</h2>
            <p className={styles.cardRole}>
              {s.hire.displayName} · {s.hire.jobTitle}
            </p>
            <p className={styles.cardSummary}>{s.summary}</p>
            <Link href={`/demo/${s.slug}`} className={styles.cardLink}>
              Open scenario
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
