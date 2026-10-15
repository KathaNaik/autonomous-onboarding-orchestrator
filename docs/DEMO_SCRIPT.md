# Swift demo video: what to say and show

Speaker notes for the Build First video. The brief asks you to explain clearly **why you chose this problem, who the users are, the impact and ROI you expect, and the key tech choices and trade-offs**. Each has its own section below, in the order to say them, followed by the live demo and a shot list.

Target length about 6–7 minutes. Cut the waiting (the worker runs once a minute) in editing.

---

## Before you record

- **Record on a weekday, 09:00–16:59 Phoenix time.** The production worker only runs then (QStash schedule). Outside those hours, trigger one run with `pnpm qstash:worker:wake --confirm`.
- **Use a fresh operator account.** Each account can start **one onboarding per day** (`ONBOARDING_START_DAILY_LIMIT_PER_OPERATOR`). Create the account the day before, or use one that hasn't started an onboarding today.
- **Have a synthetic offer letter ready** (for example `~/Desktop/swift-test-offer-letter.pdf`). Use a made-up person, a full-time software engineer, so the run shows an approval.
- **GitHub username:** use your own GitHub account that is **not already linked** to another hire. The fixture `kathanaik4` is linked to the first production run's employee, so recording it for a new hire is refused ("GitHub account already linked to another employee"). That refusal is a good safety example if you want to show it, but it stops GitHub for that hire.
- **ServiceNow:** be signed in to the PDI (`dev225201`) in another tab with an account that can approve and set `fulfillment_state` (the fulfiller account is machine-only, so use your admin/approver login in the browser).
- **Tabs to have open:** the landing page, the operator console (signed in), the ServiceNow PDI list of Onboarding Access Requests, and optionally the Okta and GitHub `aoo-sandbox` admin pages.
- Light or dark theme: pick one and keep it for the whole video.

---

## 1. Why this problem (about 45 s)

**Say:**

> "At two jobs in a row, I spent my first weeks waiting for access. At my current role it took four weeks to finish onboarding. Not because anyone was slow on purpose: access is spread across HR, IT, managers and approvers, every tool has its own request, and nobody has one view of what's still missing.
>
> It isn't just me. In Ivanti's survey of over 400 IT professionals, just 15% of employees have all the resources they need on day one, and 27% of IT teams say getting a new hire everything takes more than a week. In BambooHR's survey of 1,500 US employees, lack of access to essential tools is one of new hires' biggest onboarding frustrations, at 58%."

**Show:** the landing page hero, then scroll to "How it started".

**Sources** (cite on screen or in the description):

- Ivanti, September 2019: [Survey: 85% of employees don't have all the resources they need on day one](https://www.ivanti.com/company/press-releases/2019/survey-85-of-employees-don-t-have-all-the-resources-they-need-on-day-one-to-do-their-job)
- BambooHR: [The definitive guide to onboarding](https://www.bamboohr.com/resources/guides/the-definitive-guide-to-successfully-onboarding-your-new-employees/) ("Lack of access to essential tools (58%)"; survey year not stated on the page)

**Don't say** "86% of new hires lack tools on day one (BetterCloud)": in BetterCloud's 2023 report, 86% is the share of IT professionals who say automation is important. It's not a day-one figure.

---

## 2. Who the users are (about 30 s)

**Say:**

> "Swift is for the HR and IT people who onboard new hires, plus the people they wait on: approvers and IT fulfillers in ServiceNow. The new hire benefits, but never logs in.
>
> - **HR or IT operators** upload the signed offer letter, confirm the details, record the GitHub username and confirm tools that can't be set up automatically.
> - **Approvers** decide sensitive access, like production, in ServiceNow, where they already work.
> - **IT fulfillers** complete the ServiceNow requests Swift opens for tools without an API.
> - **The new hire** gets their accounts and a first-month plan."

**Show:** the landing section "What you do, and what Swift does".

---

## 3. What Swift does, live (about 3 min)

Narrate as you go. The one-sentence version: **"The AI suggests, the rules decide, Swift does the work, and people stay in charge."**

1. **Start from the offer letter.** Operator console → New onboarding → upload the PDF.
   - _Say:_ "An AI extractor reads the letter and proposes the display fields. It never sees or sets the facts that drive access, never stores the PDF, and drops salary and personal numbers."
   - _Show:_ the review page. Point out that **department, role family and employment type are chosen by me, not the AI**, then tick the attestation and start.
2. **Access planning.** The workflow page.
   - _Say:_ "An agent reads the role and job description and suggests tools, only from a fixed, versioned catalog. Then deterministic rules decide each tool on its own: allow, deny, or send to an approver."
   - _Show:_ the status line ("2 of 6 tools ready · 1 needs you · waiting on 2 people"), the "Tools and access" table, and one "Why" (AI reason + rule).
3. **Needs your attention.** Record your GitHub username.
   - _Say:_ "Swift resolves the username to GitHub's permanent account id and sends a real organization invitation. Team access waits until the invitation is accepted, because it depends on it."
4. **Human approval in ServiceNow.** Switch to the PDI, approve the production request.
   - _Say:_ "ServiceNow tells Swift something changed, but Swift doesn't trust the message: it reads the ticket back and decides from what ServiceNow actually says. Every other tool kept going while this waited."
5. **Fulfillment.** In the PDI, set the fulfillment requests to fulfilled.
   - _Say:_ "Tools without an API become ServiceNow requests for IT. Swift marks them ready only after it reads 'fulfilled' back."
6. **Done.** Back in Swift: tools turn Ready, the workflow completes, and the **Plan** tab shows the first-month checklist.
   - _Say:_ "A second agent writes the plan, and it may only mention tools the person actually has."
7. **Audit.** Open **Audit & technical**.
   - _Say:_ "Every suggestion, decision, approval and change is recorded with who made it and which rule version decided it, so any decision can be replayed and explained."

If the live run is slow, show steps 1–3 live and use the **completed production run** (or the public demo's completed scenario) for 4–7, and say so.

---

## 4. Failure handling (about 30 s)

**Say:**

> "The part I'm proudest of is what happens when things go wrong. In a full run on production, Swift stopped on an Okta group I'd forgotten to configure. It didn't fail the onboarding or guess; it waited. Once I added the group, the next scheduled run carried on from where it stopped. Then I sent the same HR event again and let the worker run three more times: nothing changed. Still one account, one approval, three fulfillment requests, no new writes."

**Show:** the landing section "What a real run looked like", or that workflow's Activity tab.

Be precise: the fix was a configuration change plus a small code change so configuration problems are re-checked. Say "it stopped safely and resumed", not "it recovered automatically".

---

## 5. Impact and ROI I expect (about 45 s)

Frame this as **expected impact to measure**, not a measured result. Swift hasn't run inside a real company yet.

**Say:**

> "This is a proof of concept, so I'm not claiming measured savings. Here's what I expect to change, and how a pilot would prove it:
>
> - **Time to required access**: from days or weeks of tickets to minutes for everything automatic. Approvals still take as long as the approver.
> - **Manual IT touches per hire**: one upload and a few decisions, instead of a ticket per tool.
> - **Fewer mistakes**: access comes from versioned rules, not memory, and nothing is granted that the rules don't allow.
> - **Visibility**: one page shows who is waiting on what.
>
> A pilot would measure each of these before and after on the same team."

**If you want a number, use the formula, not a made-up result:**

```
annual value ≈ hires per year × (hours of waiting removed per hire × loaded cost of the new hire
                                 + IT hours saved per hire × loaded IT cost)
```

Plug in a company's own numbers in a pilot. Don't present example inputs as findings.

---

## 6. Key tech choices and trade-offs (about 1 min)

**Say** two or three of these; keep the rest for questions.

| Choice                                                                                                                  | Why                                                                                                   | Trade-off                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI suggests, rules decide.** Agents only return structured data; a deterministic, versioned policy engine authorizes. | Access decisions must be explainable and repeatable. An AI can't grant anything, even if manipulated. | Someone has to write and maintain the rules. Today they decide by department, role family and employment type, which is coarser than the AI's reading of the job. |
| **AI limited to a fixed catalog, strict structured outputs, no tools.**                                                 | It can't invent a tool or take an action. Output is validated before anything uses it.                | New tools need a catalog release. The catalog today is mostly engineering tools.                                                                                  |
| **Each tool handled on its own.**                                                                                       | One slow approval never blocks the rest; dependencies (GitHub org before team) are respected.         | More state to track per hire.                                                                                                                                     |
| **Custom durable workflow on PostgreSQL + transactional outbox**, instead of Temporal or Step Functions.                | Survives crashes and redeploys with one database and no extra infrastructure; runs on free tiers.     | More code to own and test myself.                                                                                                                                 |
| **Check before every write, confirm after** (idempotency keys, reconciliation, read-back).                              | Retries and duplicate events never create a second account or ticket.                                 | Extra reads against each provider.                                                                                                                                |
| **ServiceNow for humans.** Approvals and fulfillment happen where approvers and IT already work.                        | No new tool to learn; Swift trusts ServiceNow's state, not the callback message.                      | Setup in ServiceNow (table, roles, business rules).                                                                                                               |
| **Vercel Hobby + Neon + a QStash scheduler.**                                                                           | Real public deployment at no cost.                                                                    | The worker only runs on weekday business hours; work waits safely until then.                                                                                     |
| **Sandboxes and synthetic data, open sign-up with caps.**                                                               | Reviewers can try the real flow against real APIs.                                                    | It's a proof of concept: no SSO or roles, and each account is limited (1 onboarding and 3 uploads a day).                                                         |

**Stack** (one line, on screen): Next.js 16 and React 19, Fastify 5, TypeScript, Zod 4 contracts, PostgreSQL (Neon) with Drizzle, OpenAI (two agents + one extractor), ServiceNow, Okta, GitHub, Vercel, Upstash QStash. 811 unit tests and 369 integration tests against real PostgreSQL.

---

## 7. Close (about 15 s)

**Say:**

> "Swift turns a signed offer into ready access and a first-month plan, with people deciding only what needs a person. Next, I'd add finance and sales tools to the catalog, connect to a real HR system, and run a pilot to measure time to access."

**Show:** the landing page, "Try the demo".

---

## Claims to avoid

- That existing tools only do basic provisioning. Okta, Rippling and ServiceNow can assign apps by department or title. Swift's difference is reading the offer letter, AI suggestions held to a catalog and decided by rules, and tracking every tool through approvals and fulfillment in one place.
- That Swift provisions Lucidchart, QuickBooks or other tools that aren't in the catalog.
- That the rules decide from the job description. They decide from department, role family and employment type; the AI suggestion is what reads the job.
- Measured savings, or "four weeks down to minutes" as a result. Say "expected" and "the automatic part".
- That the missing Okta group was fixed automatically.

---

## Shot list

| #   | Time      | Screen                                           | Say                                     |
| --- | --------- | ------------------------------------------------ | --------------------------------------- |
| 1   | 0:00–0:45 | Landing hero → "How it started"                  | Why this problem + the two statistics   |
| 2   | 0:45–1:15 | "What you do, and what Swift does"               | Who the users are                       |
| 3   | 1:15–2:15 | Upload → review → start                          | Offer letter, operator picks the facts  |
| 4   | 2:15–3:00 | Workflow overview, Why, GitHub username          | AI suggests, rules decide, dependencies |
| 5   | 3:00–3:45 | ServiceNow approve + fulfill → Swift turns Ready | Human approval, read-back               |
| 6   | 3:45–4:15 | Plan tab, Audit & technical                      | Plan from granted access, audit trail   |
| 7   | 4:15–4:45 | "What a real run looked like" / Activity         | Failure handling                        |
| 8   | 4:45–5:30 | Landing or a simple slide                        | Impact and ROI                          |
| 9   | 5:30–6:30 | Slide with the trade-off table                   | Tech choices and trade-offs             |
| 10  | 6:30–6:45 | Landing                                          | Close                                   |
