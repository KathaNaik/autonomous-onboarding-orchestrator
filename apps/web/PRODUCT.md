# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally:

- **Reviewers** (hiring managers, technical reviewers, Build First judges) evaluating Swift as a portfolio project. They arrive at the landing page, try the public demo, and may sign up to use the operator console. They judge whether the product is real, whether the engineering is sound, and whether the claims are honest.
- **HR and IT operators** who onboard new hires. They upload a signed offer letter, confirm the hire's details and canonical facts, record a GitHub username when asked, set up tools that have no API, and watch each hire's progress in the operator console. Approvers and IT fulfillers act in ServiceNow, not in Swift. The new hire never signs in to Swift.

## Product Purpose

Swift (AOO, the Autonomous Onboarding Orchestrator) turns a signed offer into ready access and a first-month plan. It exists because onboarding access is spread across HR, IT, managers and approvers, with a request per tool and no single view of what is still missing. Success: everyday tools are ready within seconds of the onboarding starting, sensitive access waits only on the person who must decide, and anyone can see what happened to a hire and why.

## Positioning

AI only suggests; versioned, replayable access rules decide; real systems (Okta, ServiceNow, GitHub) do the work through idempotent, read-back-verified operations; and people step in only where a decision needs a person. Every step is recorded.

## Operating Context

- Intake: a signed HR-system event, or an operator uploading a signed offer letter (PDF, never stored) that an AI extractor reads; the operator confirms every field and chooses department, role family and employment type.
- Tools (catalog 1.1.0): Okta engineering group, Jira, Slack and AWS development are Okta group memberships (automatic); AWS production needs a ServiceNow approval, then a separate ServiceNow fulfillment; GitHub org and team follow an HR-recorded username and an invitation the hire accepts; the Cursor license is set up by the operator and marked done.
- Background work runs on a weekday business-hours schedule (America/Phoenix, free-tier QStash); the site, API and webhooks are available around the clock.
- Surfaces: public landing page, public synthetic demo (three scenarios), operator sign-in/sign-up, workflows list, workflow detail (Overview, Plan, Activity, Audit & technical), offer-letter upload and review, GitHub-username page.

## Capabilities and Constraints

- Next.js 16 App Router, server-rendered. The only client components are the landing page's interactive example and the theme menu; the operator console ships no client JavaScript and the browser never holds credentials.
- Three AI components, each bounded: the Offer Letter Extractor (proposes display fields), the Role Access Agent (suggests catalog tools), the Onboarding Plan Agent (writes a checklist from tools actually granted).
- Operator recovery: retry a failed tool; request a new approval only after ServiceNow confirms the old ticket is gone.
- Timing shown from durable timestamps: start date and readiness, time to access, time to completion, per-tool readiness.
- Limits: anyone can sign up and is a full operator (proof of concept), one onboarding per operator per day, Okta accounts stay staged (Swift never activates them or sets passwords), one GitHub sandbox test account.
- Terminology: "tools" (not entitlements) in user-facing copy; "operator" for HR/IT users; "approver" and "IT" for ServiceNow people.

## Brand Commitments

- Name **Swift** and the S-path logo (a workflow path with step dots ending in a check): `apps/web/components/console/icons.tsx` (`Logo`), `apps/web/app/icon.svg`, `apps/web/app/apple-icon.png`.
- The founder story, kept verbatim: "It took me four weeks to finish onboarding at my current role."
- Honest, measured claims only: no invented customers, testimonials, metrics or savings; synthetic data is always labelled as synthetic.
- A Light / Dark / Device theme menu on every page.

## Evidence on Hand

- Real production runs: the M10 run (workflow `f11dc8ba-…`, completed, 7 of 7 tools, 12-task plan) and the M14 run (Morgan Vale, workflow `84181a2c-…`: Okta tools ready 29–33 s after the start, AWS production after approval and fulfillment in 11 min).
- Operator page screenshot from a synthetic view: `apps/web/public/console-workflow.png`; repository screenshots in `docs/screenshots/`.
- Cited statistics: Ivanti (September 2019, 400+ IT professionals: 15% of employees have everything on day one; 27% of IT teams say it takes more than a week); BambooHR (1,500 US employees: 58% name lack of access to essential tools among their biggest onboarding frustrations).
- Test counts: 844 unit, 380 integration (at M14).
- Absent and not to be fabricated: customers, testimonials, pilot results, measured time or cost savings, pricing, SLAs, enterprise production usage.

## Product Principles

1. People decide only what needs a person; everything else just happens.
2. Show the evidence: every status, decision and timing on screen comes from a durable record, and every claim can be checked.
3. Plain language for operators; raw codes and identifiers stay under "Technical details".
4. Honest by default: synthetic is labelled, limits are stated, nothing is implied that the system doesn't do.

## Accessibility & Inclusion

Established practice to keep: labelled form fields, visible focus, named controls, status shown as text plus icon (color is secondary), no horizontal overflow at 390 px, light and dark themes, server-rendered pages that work without JavaScript.
