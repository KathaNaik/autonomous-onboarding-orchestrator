import Link from "next/link";
import type { ReactNode } from "react";
import { geistMono, geistSans } from "@/components/console/fonts";
import * as I from "@/components/console/icons";
import { ActorChip, StatusBadge, cx, styles as c } from "@/components/console/ui";
import { stateLabel, toneOf } from "@/lib/console-model";
import { DEMO_SCENARIOS } from "@/lib/demo-data";
import { OnboardingSimulator } from "./onboarding-simulator";
import styles from "./page.module.css";

export const dynamic = "force-static";

const INTEGRATIONS = ["ServiceNow", "Okta", "GitHub", "OpenAI"];

const STEPS: { actor: "AI" | "Policy" | "Worker"; chip: string; title: string; text: string }[] = [
  {
    actor: "AI",
    chip: "AI recommends",
    title: "Recommend access",
    text: "An agent reads the role and suggests tools, only from a versioned catalog. Its output is a request, never a decision.",
  },
  {
    actor: "Policy",
    chip: "Policy authorizes",
    title: "Authorize each tool",
    text: "Deterministic, versioned rules allow, deny or ask for a human approval in ServiceNow, one tool at a time.",
  },
  {
    actor: "Worker",
    chip: "Swift executes",
    title: "Set up and verify",
    text: "A durable workflow sets up Okta, GitHub and ServiceNow access in dependency order, confirms each change and retries safely.",
  },
];

const GUARANTEES: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <I.Shield size={18} />,
    title: "Decisions you can replay",
    text: "Every decision records the exact policy and catalog version it used, so it can be explained and re-checked later.",
  },
  {
    icon: <I.Check size={18} />,
    title: "No duplicate accounts",
    text: "Each change in ServiceNow, Okta or GitHub is checked before and confirmed after, so a retry never repeats it.",
  },
  {
    icon: <I.Clock size={18} />,
    title: "Nothing gets lost",
    text: "Onboardings survive restarts and outages. Work that is waiting on a person picks up again on its own.",
  },
  {
    icon: <I.FileDoc size={18} />,
    title: "A complete audit trail",
    text: "An append-only record of every recommendation, decision, approval and change, with who did it.",
  },
];

const TECH_STACK: { label: string; items: string[] }[] = [
  { label: "Frontend", items: ["Next.js 16", "React 19", "TypeScript"] },
  { label: "Backend", items: ["Node.js 24", "Fastify 5", "Zod 4 contracts"] },
  {
    label: "Data and workflow",
    items: ["PostgreSQL (Neon)", "Drizzle ORM", "Transactional outbox"],
  },
  {
    label: "AI",
    items: [
      "OpenAI: two agents",
      "One offer-letter extractor",
      "Strict structured outputs, no tools",
    ],
  },
  { label: "Integrations", items: ["ServiceNow", "Okta", "GitHub"] },
  { label: "Infrastructure", items: ["Vercel", "Upstash QStash", "Docker Compose"] },
  {
    label: "Quality",
    items: ["Vitest: 800+ unit tests", "368 integration tests", "OpenTelemetry"],
  },
  {
    label: "Security",
    items: ["Signed webhooks", "Idempotent provider writes", "Append-only audit"],
  },
];

/** Public landing page: what Swift is, an interactive example, why it exists, how it works. */
export default function HomePage() {
  return (
    <div className={cx(c.root, geistSans.variable, geistMono.variable, styles.page)}>
      <div className={styles.dark}>
        <header className={cx(styles.container, styles.topbar)}>
          <Link href="/" className={styles.brand}>
            <span className={styles.brandMark}>
              <I.Logo />
            </span>
            Swift
          </Link>
          <nav aria-label="Site" className={styles.topLinks}>
            <Link href="/demo" className={styles.topLink}>
              Demo
            </Link>
            <Link href="/admin/onboarding/login" className={styles.topButton}>
              Operator login
            </Link>
          </nav>
        </header>

        <section className={cx(styles.container, styles.hero)}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Swift · AOO · Autonomous Onboarding Orchestrator</p>
            <h1 className={styles.title}>
              New hires ready on day one, <span className={styles.titleAccent}>not week four.</span>
            </h1>
            <p className={styles.lead}>
              As soon as an offer is signed, Swift works out which tools the person needs, asks a
              human to approve anything sensitive, sets up their accounts and hands them a plan for
              their first month.
            </p>
            <div className={styles.ctas}>
              <Link href="/demo" className={styles.ctaPrimary}>
                Explore the demo
              </Link>
              <Link href="/admin/onboarding/login" className={styles.ctaSecondary}>
                Operator login
              </Link>
            </div>
            <p className={styles.works}>
              <span>Works with</span>
              {INTEGRATIONS.map((name) => (
                <span key={name} className={styles.worksItem}>
                  {name}
                </span>
              ))}
            </p>
          </div>
          <div className={styles.heroDemo}>
            <p className={styles.demoHint}>
              <I.Sparkle size={14} /> Interactive example: step through an onboarding
            </p>
            <OnboardingSimulator />
          </div>
        </section>
      </div>

      <main>
        <section className={styles.section} aria-labelledby="story">
          <div className={cx(styles.container, styles.story)}>
            <div>
              <p className={styles.kicker}>Why Swift</p>
              <h2 id="story" className={styles.sectionTitle}>
                How it started
              </h2>
              <blockquote className={styles.quote}>
                It took me four weeks to finish onboarding at my current role.
              </blockquote>
              <p className={styles.storyText}>
                Swift is my attempt to make that path fast: the requests, approvals and account
                setup happen automatically, and people only step in for the decisions that need
                them. Every step is recorded, so anyone can see what happened to a hire and why.
              </p>
            </div>
            <div className={styles.compare} aria-label="Before and after">
              <div className={styles.compareCol}>
                <p className={styles.compareLabel}>The usual way</p>
                <p className={styles.compareBig}>4 weeks</p>
                <ul className={styles.compareList}>
                  <li>Tickets and emails for every tool</li>
                  <li>Approvals chased by hand</li>
                  <li>No single view of what&apos;s missing</li>
                </ul>
              </div>
              <div className={cx(styles.compareCol, styles.compareSwift)}>
                <p className={styles.compareLabel}>With Swift</p>
                <p className={styles.compareBig}>Minutes</p>
                <ul className={styles.compareList}>
                  <li>Access worked out from the role</li>
                  <li>People only decide what&apos;s sensitive</li>
                  <li>One page shows who&apos;s waiting on what</li>
                </ul>
              </div>
              <p className={styles.compareNote}>
                Minutes for the automatic part; human approvals take as long as the approver.
              </p>
            </div>
          </div>
        </section>

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="how">
          <div className={styles.container}>
            <p className={styles.kicker}>How it works</p>
            <h2 id="how" className={styles.sectionTitle}>
              Three parts, each with one job
            </h2>
            <p className={styles.sectionIntro}>
              The AI never decides access, and nothing is set up without an authorization.
            </p>
            <ol className={styles.steps}>
              {STEPS.map((step, i) => (
                <li key={step.title} className={styles.step}>
                  <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                  <ActorChip actor={step.actor} label={step.chip} />
                  <p className={styles.stepTitle}>{step.title}</p>
                  <p className={styles.stepText}>{step.text}</p>
                </li>
              ))}
            </ol>
            <div className={styles.humans}>
              <span className={styles.humansIcon}>
                <I.Person size={16} />
              </span>
              <p>
                <strong>People stay in charge.</strong> HR confirms every hire, approvers decide
                sensitive access, and a second agent writes the first-month plan only from access
                that was actually granted.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="guarantees">
          <div className={styles.container}>
            <p className={styles.kicker}>Built to be trusted</p>
            <h2 id="guarantees" className={styles.sectionTitle}>
              Safe to automate
            </h2>
            <div className={styles.guarantees}>
              {GUARANTEES.map((g) => (
                <div key={g.title} className={styles.guarantee}>
                  <span className={styles.guaranteeIcon}>{g.icon}</span>
                  <p className={styles.guaranteeTitle}>{g.title}</p>
                  <p className={styles.guaranteeText}>{g.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.cta} aria-label="Try it">
          <div className={cx(styles.container, styles.ctaInner)}>
            <div>
              <p className={styles.ctaText}>
                See a full onboarding, from signed offer to first-month plan.
              </p>
              <p className={styles.ctaSub}>Synthetic hires; nothing touches real accounts.</p>
            </div>
            <Link href="/demo" className={styles.ctaPrimary}>
              Try it
            </Link>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="scenarios-title">
          <div className={styles.container}>
            <p className={styles.kicker}>Demo</p>
            <h2 id="scenarios-title" className={styles.sectionTitle}>
              Demo scenarios
            </h2>
            <p className={styles.sectionIntro}>
              Three example onboardings with made-up people, shown the way an operator sees them.
            </p>
            <div className={styles.cards}>
              {DEMO_SCENARIOS.map((s) => (
                <Link key={s.slug} href={`/demo/${s.slug}`} className={styles.card}>
                  <span>
                    <StatusBadge
                      tone={toneOf(s.state)}
                      label={stateLabel(s.state)}
                      code={s.state}
                    />
                  </span>
                  <span className={styles.cardTitle}>{s.title}</span>
                  <span className={styles.cardRole}>{s.hire.jobTitle}</span>
                  <span className={styles.cardSummary}>{s.summary}</span>
                  <span className={styles.cardLink}>Open scenario →</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="stack-title">
          <div className={styles.container}>
            <p className={styles.kicker}>Under the hood</p>
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
        <div className={cx(styles.container, styles.footerInner)}>
          <span>Swift · AOO. Demo data is synthetic; integrations use sandbox accounts.</span>
          <span className={styles.footerLinks}>
            <Link href="/demo">Demo</Link>
            <Link href="/admin/onboarding/login">Operator login</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
