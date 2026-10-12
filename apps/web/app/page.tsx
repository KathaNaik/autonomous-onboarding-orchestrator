import Link from "next/link";
import { geistMono, geistSans } from "@/components/console/fonts";
import * as I from "@/components/console/icons";
import {
  ActorChip,
  ButtonLink,
  DataTable,
  Lifecycle,
  StatusBadge,
  cx,
  styles as c,
} from "@/components/console/ui";
import { stateLabel, toneOf } from "@/lib/console-model";
import { DEMO_SCENARIOS } from "@/lib/demo-data";
import styles from "./page.module.css";

export const dynamic = "force-static";

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
  { label: "Quality", items: ["Vitest: 800 unit tests", "368 integration tests", "OpenTelemetry"] },
  {
    label: "Security",
    items: ["Signed webhooks", "Idempotent provider writes", "Append-only audit"],
  },
];

/** A small confidence bar with its percentage (the column header names it). */
function Confidence({ value }: { value: number }) {
  return (
    <span className={c.meter}>
      <span className={c.meterTrack} aria-hidden="true">
        <span className={c.meterFill} style={{ width: `${value}%`, display: "block" }} />
      </span>
      {value}%
    </span>
  );
}

/** A product fragment for the hero: the console's own components, synthetic data. */
function ProductFragment() {
  return (
    <figure className={styles.product} aria-label="Example onboarding in the Swift console">
      <div className={styles.productHead}>
        <div>
          <div className={styles.productName}>Jordan Rivera</div>
          <div className={styles.productMeta}>
            Frontend Software Engineer · Engineering, Full-time
          </div>
        </div>
        <StatusBadge tone="amber" label="Awaiting approval" />
      </div>
      <div className={styles.productLifecycle}>
        <Lifecycle
          compact
          steps={[
            { label: "Intake", status: "done" },
            { label: "Access planning", status: "done" },
            { label: "Approval", status: "current" },
            { label: "Provisioning", status: "upcoming" },
            { label: "Onboarding plan", status: "upcoming" },
            { label: "Complete", status: "upcoming" },
          ]}
        />
      </div>
      <DataTable
        caption="How each resource is decided"
        columns={[
          { key: "resource", label: "Resource", primary: true },
          { key: "ai", label: "AI recommends" },
          { key: "policy", label: "Policy authorizes" },
          { key: "run", label: "Orchestrator executes" },
        ]}
        rows={[
          {
            key: "gh",
            cells: {
              resource: <span className={c.primaryText}>GitHub organization</span>,
              ai: <Confidence value={92} />,
              policy: <StatusBadge tone="green" label="Allow" />,
              run: <StatusBadge tone="green" label="Provisioned" />,
            },
          },
          {
            key: "dev",
            cells: {
              resource: <span className={c.primaryText}>AWS development account</span>,
              ai: <Confidence value={88} />,
              policy: <StatusBadge tone="green" label="Allow" />,
              run: <StatusBadge tone="blue" label="In progress" />,
            },
          },
          {
            key: "prod",
            cells: {
              resource: <span className={c.primaryText}>AWS production account</span>,
              ai: <Confidence value={71} />,
              policy: <StatusBadge tone="amber" label="Requires approval" />,
              run: <span className={c.muted}>Waits for approval</span>,
            },
          },
        ]}
      />
      <figcaption className={styles.productNote}>
        Synthetic example. Each resource is decided and provisioned on its own, so one pending
        approval never blocks the rest.
      </figcaption>
    </figure>
  );
}

/** Public landing page: what Swift is, why it exists, how it works, a way to try it, the stack. */
export default function HomePage() {
  return (
    <div className={cx(c.root, geistSans.variable, geistMono.variable, styles.page)}>
      <header className={styles.topbar}>
        <div className={cx(styles.container, styles.topbarInner)}>
          <Link href="/" className={c.brand}>
            <span className={c.brandMark}>
              <I.Logo />
            </span>
            Swift
          </Link>
          <nav aria-label="Site" className={styles.topLinks}>
            <Link href="/demo" className={c.navLink}>
              Demo
            </Link>
            <ButtonLink href="/admin/onboarding/login" variant="secondary">
              Operator login
            </ButtonLink>
          </nav>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={cx(styles.container, styles.heroGrid)}>
            <div>
              <h1 className={styles.title}>Swift</h1>
              <p className={styles.subtitle}>AOO · Autonomous Onboarding Orchestrator</p>
              <p className={styles.lead}>
                Swift gets a new hire ready to work without the wait. As soon as an offer is signed,
                it works out which tools the person needs, asks a human to approve anything
                sensitive, sets up their accounts, and hands them a plan for their first month.
              </p>
              <div className={styles.ctas}>
                <ButtonLink href="/demo" variant="primary" className={styles.bigButton}>
                  Explore the demo
                </ButtonLink>
                <ButtonLink
                  href="/admin/onboarding/login"
                  variant="secondary"
                  className={styles.bigButton}
                >
                  Operator login
                </ButtonLink>
              </div>
              <p className={styles.chain} aria-label="How decisions flow">
                <ActorChip actor="AI" label="AI recommends" />
                <span aria-hidden="true">→</span>
                <ActorChip actor="Policy" label="Policy authorizes" />
                <span aria-hidden="true">→</span>
                <ActorChip actor="Worker" label="Orchestrator executes" />
              </p>
            </div>
            <ProductFragment />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="story">
          <div className={cx(styles.container, styles.story)}>
            <div>
              <h2 id="story" className={styles.sectionTitle}>
                How it started
              </h2>
              <blockquote className={styles.quote}>
                It took me two weeks to finish onboarding at my current contract role.
              </blockquote>
            </div>
            <p className={styles.storyText}>
              Swift is my attempt to make that path fast: the requests, approvals and account setup
              happen automatically, and people only step in for the decisions that need them. Every
              step is recorded, so anyone can see what happened to a hire and why.
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <div className={styles.container}>
            <h2 id="how" className={styles.sectionTitle}>
              How it works
            </h2>
            <p className={styles.sectionIntro}>
              Three separate parts, each with one job. The AI never decides access, and nothing is
              provisioned without an authorization.
            </p>
            <ol className={styles.steps}>
              <li className={styles.step}>
                <ActorChip actor="AI" label="AI recommends" />
                <p className={styles.stepTitle}>Recommend access</p>
                <p className={styles.stepText}>
                  An agent reads the role and suggests tools, only from a versioned catalog. Its
                  output is a request, never a decision.
                </p>
              </li>
              <li className={styles.step}>
                <ActorChip actor="Policy" label="Policy authorizes" />
                <p className={styles.stepTitle}>Authorize each resource</p>
                <p className={styles.stepText}>
                  Deterministic, versioned rules allow, deny or require a human approval in
                  ServiceNow, one resource at a time.
                </p>
              </li>
              <li className={styles.step}>
                <ActorChip actor="Worker" label="Orchestrator executes" />
                <p className={styles.stepTitle}>Provision and verify</p>
                <p className={styles.stepText}>
                  A durable workflow sets up Okta, GitHub and ServiceNow access in dependency order,
                  confirms each change and retries safely.
                </p>
              </li>
            </ol>
            <p className={styles.humans}>
              <I.Person size={16} />
              <span>
                People stay in charge: HR confirms every hire, approvers decide sensitive access,
                and a second agent writes the first-month plan only from access that was actually
                granted.
              </span>
            </p>
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
            <Link href="/demo" className={cx(c.button, c.primary, styles.bigButton)}>
              Try it
            </Link>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="scenarios-title">
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
                    <StatusBadge
                      tone={toneOf(s.state)}
                      label={stateLabel(s.state)}
                      code={s.state}
                    />
                  </div>
                  <h3 className={styles.cardTitle}>{s.title}</h3>
                  <p className={styles.cardRole}>{s.hire.jobTitle}</p>
                  <p className={styles.cardSummary}>{s.summary}</p>
                  <Link href={`/demo/${s.slug}`} className={styles.cardLink}>
                    Open scenario
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
        <div className={cx(styles.container, styles.footerInner)}>
          <span>Swift · AOO. Demo data is synthetic; integrations use sandbox accounts.</span>
          <Link href="/admin/onboarding/login">Operator login</Link>
        </div>
      </footer>
    </div>
  );
}
