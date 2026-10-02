import Link from "next/link";
import { Badge } from "@/components/badge";
import { DEMO_SCENARIOS } from "@/lib/demo-data";
import styles from "./page.module.css";

export const dynamic = "force-static";

const TECH_STACK: { label: string; items: string[] }[] = [
  { label: "Frontend", items: ["Next.js 16", "React 19", "TypeScript"] },
  { label: "Backend", items: ["Node.js 24", "Fastify 5", "Zod 4 contracts"] },
  {
    label: "Data & workflow",
    items: ["PostgreSQL (Neon)", "Drizzle ORM", "Transactional outbox"],
  },
  { label: "AI", items: ["OpenAI: two bounded agents", "Strict structured outputs"] },
  { label: "Integrations", items: ["ServiceNow", "Okta", "GitHub"] },
  { label: "Infrastructure", items: ["Vercel", "Upstash QStash", "Docker Compose"] },
  { label: "Quality", items: ["Vitest: 758 unit + 334 integration tests", "OpenTelemetry"] },
];

/** Public landing page: what Swift is, why it exists, a way to try it, and what it's built with. */
export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={`${styles.container} ${styles.topbarInner}`}>
          <Link href="/" className={styles.wordmark}>
            Swift
          </Link>
          <Link href="/admin/onboarding/login" className={styles.topLink}>
            Operator login
          </Link>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.container}>
            <p className={styles.eyebrow}>AOO · Autonomous Onboarding Orchestrator</p>
            <h1 className={styles.title}>Swift</h1>
            <p className={styles.lead}>
              Swift gets a new hire ready to work without the wait. As soon as an offer is signed,
              it works out which tools the person needs, asks a human to approve anything sensitive,
              sets up their accounts, and hands them a plan for their first month.
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="story">
          <div className={styles.container}>
            <h2 id="story" className={styles.sectionTitle}>
              How it started
            </h2>
            <div className={styles.story}>
              <blockquote className={styles.quote}>
                It took me two weeks to finish onboarding at my current contract role.
              </blockquote>
              <p className={styles.storyText}>
                Swift is my attempt to make that path fast: the requests, approvals and account
                setup happen automatically, and people only step in for the decisions that need
                them.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.cta} aria-label="Try it">
          <div className={styles.container}>
            <p className={styles.ctaText}>
              See a full onboarding, from signed offer to first-month plan.
            </p>
            <Link href="/demo" className={styles.tryIt}>
              Try it
            </Link>
          </div>
        </section>

        <section id="scenarios" className={styles.section} aria-labelledby="scenarios-title">
          <div className={styles.container}>
            <h2 id="scenarios-title" className={styles.sectionTitle}>
              Demo scenarios
            </h2>
            <p className={styles.sectionIntro}>
              Three example onboardings with made-up people. Nothing here touches real accounts.
            </p>
            <div className={styles.cards}>
              {DEMO_SCENARIOS.map((s) => (
                <article key={s.slug} className={styles.card}>
                  <div>
                    <Badge value={s.state} />
                  </div>
                  <h3 className={styles.cardTitle}>{s.title}</h3>
                  <p className={styles.cardRole}>{s.hire.jobTitle}</p>
                  <p className={styles.cardSummary}>{s.summary}</p>
                  <Link href={`/demo/${s.slug}`} className={styles.cardLink}>
                    Open scenario →
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="stack-title">
          <div className={styles.container}>
            <h2 id="stack-title" className={styles.sectionTitle}>
              Tech stack
            </h2>
            <div className={styles.stack}>
              {TECH_STACK.map((group) => (
                <div key={group.label} className={styles.stackGroup}>
                  <p className={styles.stackLabel}>{group.label}</p>
                  <ul className={styles.stackList}>
                    {group.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <span>Swift · AOO. Demo data is synthetic; integrations use sandbox accounts.</span>
          <Link href="/admin/onboarding/login" className={styles.topLink}>
            Operator login
          </Link>
        </div>
      </footer>
    </div>
  );
}
