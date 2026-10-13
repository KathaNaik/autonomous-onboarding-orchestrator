import Image from "next/image";
import Link from "next/link";
import { geistMono, geistSans } from "@/components/console/fonts";
import { ThemeMenu } from "@/components/console/theme-menu";
import * as I from "@/components/console/icons";
import { StatusBadge, cx, styles as c } from "@/components/console/ui";
import { stateLabel, toneOf } from "@/lib/console-model";
import { DEMO_SCENARIOS } from "@/lib/demo-data";
import { OnboardingSimulator } from "./onboarding-simulator";
import styles from "./page.module.css";

export const dynamic = "force-static";

const YOU = [
  "Upload the signed offer letter and confirm the details",
  "Record the new hire's GitHub username",
  "Approve sensitive access in ServiceNow, if you're the approver",
  "Confirm tools that can't be set up automatically",
];

const SWIFT = [
  "Works out the access the role needs, from a fixed list of tools",
  "Checks every tool against versioned access rules",
  "Opens approval and fulfillment requests in ServiceNow",
  "Sets up Okta and GitHub, and confirms each change with the provider",
  "Writes a first-month plan from the access that was actually granted",
  "Records every step, with who or what did it",
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
    items: ["OpenAI: two agents", "One offer-letter extractor", "Structured outputs, no tools"],
  },
  { label: "Integrations", items: ["ServiceNow", "Okta", "GitHub"] },
  { label: "Infrastructure", items: ["Vercel", "Upstash QStash", "Docker Compose"] },
  { label: "Quality", items: ["800+ unit tests", "368 integration tests", "OpenTelemetry"] },
  {
    label: "Security",
    items: ["Signed webhooks", "Idempotent provider writes", "Append-only audit"],
  },
];

/** Public landing page: what Swift does, a hands-on example, real evidence, and the story. */
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
            <Link href="/admin/onboarding/login" className={cx(c.button, c.secondary)}>
              Operator login
            </Link>
            <ThemeMenu />
          </nav>
        </div>
      </header>

      <main>
        <section className={cx(styles.container, styles.hero)}>
          <div>
            <h1 className={styles.title}>Onboarding without the four weeks of tickets.</h1>
            <p className={styles.lead}>
              Swift is for HR and IT teams. Upload a signed offer letter; Swift works out the access
              the role needs, sends anything sensitive to an approver in ServiceNow, sets up Okta
              and GitHub, and writes the new hire&apos;s first-month plan. You only step in where a
              person has to decide.
            </p>
            <p className={styles.ctas}>
              <Link href="/demo" className={cx(c.button, c.primary, styles.bigButton)}>
                Try the demo
              </Link>
              <span className={styles.ctaNote}>
                Synthetic hires; nothing touches real accounts.
              </span>
            </p>
          </div>
          <div>
            <OnboardingSimulator />
            <p className={styles.simCaption}>
              A synthetic example you can click through. The approve-or-reject step is the one a
              real approver does in ServiceNow; nothing is set up that the rules didn&apos;t allow.
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="split">
          <div className={styles.container}>
            <h2 id="split" className={styles.sectionTitle}>
              What you do, and what Swift does
            </h2>
            <div className={styles.split}>
              <div>
                <h3 className={styles.splitTitle}>You (HR or IT)</h3>
                <ul className={styles.checklist}>
                  {YOU.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className={styles.splitTitle}>Swift</h3>
                <ul className={styles.checklist}>
                  {SWIFT.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className={styles.rule}>
              The AI only suggests. Deciding who gets what is done by rules your team can read, and
              every decision records the rule version it used.
            </p>
          </div>
        </section>

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="run">
          <div className={cx(styles.container, styles.evidence)}>
            <div>
              <h2 id="run" className={styles.sectionTitle}>
                What a real run looked like
              </h2>
              <p className={styles.body}>
                We ran a full onboarding on the production deployment, against real ServiceNow, Okta
                and GitHub sandbox accounts. A signed offer arrived from the HR system. The AI
                suggested 7 tools; the rules allowed 6 and sent 1 to an approver. The approval was
                made in ServiceNow, and ServiceNow told Swift over the public internet. Swift then
                opened 3 fulfillment requests in ServiceNow, created an Okta account with 2 group
                memberships, confirmed GitHub access, and wrote a 12-task first-month plan.
              </p>
              <p className={styles.body}>
                Halfway through, the run stopped on an Okta group we had forgotten to configure.
                Once it was added, the next scheduled run carried on from where it stopped.
              </p>
              <p className={styles.body}>
                Afterwards we sent the same HR event again and let the worker run three more times.
                Nothing changed: still one account, one approval, three fulfillment requests and no
                new writes anywhere.
              </p>
            </div>
            <figure className={styles.shot}>
              <Image
                src="/console-workflow.png"
                width={1200}
                height={957}
                alt="Swift's operator page for a synthetic hire: a status line reading 2 of 6 tools ready, 1 needs you, waiting on 2 people; a lifecycle at the Approval step; a to-do to record the GitHub username; and a table of six tools with their status and who acts next."
                sizes="(max-width: 1080px) 100vw, 640px"
              />
              <figcaption>
                The operator&apos;s page for a synthetic hire: what needs you, who everyone else is
                waiting on, and where each tool stands.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="story">
          <div className={styles.container}>
            <div className={styles.story}>
              <h2 id="story" className={styles.sectionTitle}>
                How it started
              </h2>
              <blockquote className={styles.quote}>
                It took me four weeks to finish onboarding at my current role.
              </blockquote>
              <p className={styles.body}>
                Swift is my attempt to make that path fast: the requests, approvals and account
                setup happen automatically, and people only step in for the decisions that need
                them. Every step is recorded, so anyone can see what happened to a hire and why.
              </p>
            </div>
          </div>
        </section>

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="scenarios">
          <div className={styles.container}>
            <h2 id="scenarios" className={styles.sectionTitle}>
              Three onboardings, as HR sees them
            </h2>
            <ul className={styles.scenarios}>
              {DEMO_SCENARIOS.map((s) => (
                <li key={s.slug} className={styles.scenario}>
                  <StatusBadge tone={toneOf(s.state)} label={stateLabel(s.state)} code={s.state} />
                  <div>
                    <Link href={`/demo/${s.slug}`} className={styles.scenarioTitle}>
                      {s.title}
                    </Link>
                    <p className={styles.scenarioText}>{s.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className={styles.more}>
              <Link href="/demo" className={cx(c.button, c.secondary)}>
                Open the demo
              </Link>
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="stack">
          <div className={styles.container}>
            <h2 id="stack" className={styles.sectionTitle}>
              Tech stack
            </h2>
            <dl className={styles.stack}>
              {TECH_STACK.map((group) => (
                <div key={group.label}>
                  <dt>{group.label}</dt>
                  <dd>{group.items.join(" · ")}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={cx(styles.container, styles.footerInner)}>
          <span>Swift · AOO, the Autonomous Onboarding Orchestrator. Demo data is synthetic.</span>
          <span className={styles.footerLinks}>
            <Link href="/demo">Demo</Link>
            <Link href="/admin/onboarding/login">Operator login</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
