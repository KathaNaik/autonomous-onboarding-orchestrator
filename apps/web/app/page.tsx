import Image from "next/image";
import Link from "next/link";
import { uiMono, uiSans } from "@/components/console/fonts";
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
  { label: "Quality", items: ["844 unit tests", "380 integration tests", "OpenTelemetry"] },
  {
    label: "Security",
    items: ["Signed webhooks", "Idempotent provider writes", "Append-only audit"],
  },
];

/** Public landing page: what Swift does, a hands-on example, real evidence, and the story. */
export default function HomePage() {
  return (
    <div className={cx(c.root, uiSans.variable, uiMono.variable, styles.page)}>
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
        <section className={styles.heroBand}>
          <div className={cx(styles.container, styles.hero)}>
            <div className={styles.heroIntro}>
              <h1 className={styles.title}>Onboarding without the four weeks of tickets.</h1>
              <p className={styles.lead}>
                Swift is for HR and IT teams. Upload a signed offer letter; Swift works out the
                access the role needs, sends anything sensitive to an approver in ServiceNow, sets
                up Okta and GitHub, and writes the new hire&apos;s first-month plan. You only step
                in where a person has to decide.
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
            <div className={styles.heroExample}>
              <OnboardingSimulator />
              <p className={styles.simCaption}>
                A synthetic example you can click through. The approve-or-reject step is the one a
                real approver does in ServiceNow; nothing is set up that the rules didn&apos;t
                allow.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.storyBand} aria-labelledby="story">
          <div className={cx(styles.container, styles.story)}>
            <h2 id="story" className={styles.srOnly}>
              Why Swift exists
            </h2>
            <blockquote className={styles.quote}>
              It took me four weeks to finish onboarding at my current role.
            </blockquote>
            <p className={styles.body}>
              Swift is my attempt to make that path fast: the requests, approvals and account setup
              happen on their own, and people only step in for the decisions that need them. Every
              step is recorded, so anyone can see what happened to a hire and why.
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="run">
          <div className={cx(styles.container, styles.evidence)}>
            <div>
              <h2 id="run" className={styles.sectionTitle}>
                One real onboarding, minute by minute
              </h2>
              <p className={styles.body}>
                An operator uploaded a signed offer letter for a synthetic engineer on the
                production deployment, which talks to real Okta, ServiceNow and GitHub sandbox
                accounts. Times are from the workflow&apos;s own records.
              </p>
              <ol className={styles.timeline}>
                <li>
                  <span className={styles.when}>0 s</span>
                  <span>Offer letter confirmed; the onboarding starts.</span>
                </li>
                <li>
                  <span className={styles.when}>29–33 s</span>
                  <span>
                    Okta account created (staged) and four tools ready with no person involved: the
                    engineering group, Jira, Slack and AWS development.
                  </span>
                </li>
                <li>
                  <span className={styles.when}>waiting</span>
                  <span>
                    AWS production needs a person. Swift opened an approval in ServiceNow and waited
                    for the approver.
                  </span>
                </li>
                <li>
                  <span className={styles.when}>11 min</span>
                  <span>
                    Approved, then set up by IT in ServiceNow. Swift read both tickets back before
                    marking the tool ready.
                  </span>
                </li>
                <li>
                  <span className={styles.when}>stopped</span>
                  <span>
                    GitHub: our only sandbox test account already belongs to an earlier hire, so
                    Swift refused to link it rather than guess.
                  </span>
                </li>
              </ol>
              <p className={styles.body}>
                Running the worker again afterwards changed nothing: still one Okta account, one
                approval and one fulfillment request.
              </p>
            </div>
            <figure className={styles.shot}>
              <Image
                src="/console-workflow.png"
                width={1200}
                height={838}
                alt="Swift's operator page for a synthetic hire: one task for the operator (record the GitHub username), AWS production waiting on an approver in ServiceNow, the GitHub team waiting on the organization, and four Okta tools ready 29 to 32 seconds after the onboarding started."
                sizes="(max-width: 1280px) 100vw, 1216px"
              />
              <figcaption>
                The operator&apos;s page for a synthetic hire: what needs you, who everyone else is
                waiting on, and how long each ready tool took.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="split">
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

        <section className={styles.section} aria-labelledby="scenarios">
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

        <section className={cx(styles.section, styles.sectionAlt)} aria-labelledby="stack">
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
        <section className={styles.close} aria-labelledby="close">
          <div className={cx(styles.container, styles.closeInner)}>
            <h2 id="close" className={styles.sectionTitle}>
              See a hire go from offer letter to first-month plan.
            </h2>
            <p className={styles.ctas}>
              <Link href="/demo" className={cx(c.button, c.primary, styles.bigButton)}>
                Try the demo
              </Link>
              <Link
                href="/admin/onboarding/signup"
                className={cx(c.button, c.secondary, styles.bigButton)}
              >
                Create an operator account
              </Link>
            </p>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={cx(styles.container, styles.footerInner)}>
          <span>
            Swift, the Autonomous Onboarding Orchestrator. A portfolio project; demo data is
            synthetic.
          </span>
          <span className={styles.footerLinks}>
            <Link href="/demo">Demo</Link>
            <Link href="/admin/onboarding/login">Operator login</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
