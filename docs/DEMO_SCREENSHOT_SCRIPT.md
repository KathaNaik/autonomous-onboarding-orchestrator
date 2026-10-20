# Swift demo video: screenshot version

Speaker notes for a voice-over on screenshots, for when you don't record the whole live walkthrough. It covers the four things the brief asks for: **why this problem, who the users are, the impact and ROI you expect, and key tech choices and trade-offs**. The live version is `DEMO_SCRIPT.md`; this one doesn't replace it.

Target length: **about 10 minutes** (timings per scene below add up to roughly 10:00). Show each picture for as long as its lines take; zoom or highlight the part you're talking about.

No screenshots are stored in the repository: take each picture yourself from the links and steps below, just before recording.

---

## How each tool is handled (catalog 1.1.0, current)

| Tool                    | Who carries it out                                    | What a person does                                       |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Okta engineering group  | **Okta, automatically**                               | nothing                                                  |
| Jira engineering        | **Okta, automatically** (group)                       | nothing                                                  |
| Slack engineering       | **Okta, automatically** (group, single sign-on)       | nothing                                                  |
| AWS development account | **Okta, automatically** (group → IAM Identity Center) | nothing                                                  |
| AWS production account  | **ServiceNow**: an approval, then a fulfillment       | an approver approves; IT fulfills                        |
| GitHub org and team     | **GitHub**, after HR records the username             | HR records the username; the hire accepts the invitation |
| Cursor license          | **The operator** (no API)                             | sets it up and marks it done                             |

Onboardings started before catalog 1.1.0 keep the catalog they started with (Slack and AWS development went through ServiceNow then). Every decision records its catalog and rules version.

## The hires this video follows

**Morgan Vale** (synthetic, the M14 production run): workflow `84181a2c-5a72-43b9-9ed3-eadb06e0de2a`, started from an offer letter, start date Mon, Nov 9, 2026.

| System     | What it shows for this hire                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swift      | Okta engineering, Jira, Slack and AWS development ready 29–33 s after the start; AWS production ready after 11 min (two human steps)                       |
| Okta       | `morgan.vale.m14-00fqwd@example.com`, **Staged**, in AOO Engineering Test, AOO Jira Engineering Test, AOO Slack Engineering Test, AOO AWS Development Test |
| ServiceNow | Only two records: `OAR0001009` (AWS production approval, approved) and `OAR0001010` (AWS production fulfillment, fulfilled)                                |
| GitHub     | Refused on purpose: the sandbox's only test account is already linked to another employee                                                                  |

**Deployed E2E 9c935c8b** (the M10 production run, completed): use it only for the **Plan** tab, since Morgan's onboarding waits on GitHub and has no plan yet. It ran on catalog 1.0.0.

**Jordan Rivera**: the recovery story (scene 13).

---

## Screenshots to take

**Swift** (sign in as an operator first). Take each in light mode, at a normal laptop width:

| #   | Picture                                                                                                  | Link                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| S1  | Landing page, top (headline + interactive example)                                                       | https://aoo-web.vercel.app                                                                     |
| S2  | Landing, "What you do, and what Swift does"                                                              | https://aoo-web.vercel.app (scroll)                                                            |
| S3  | New onboarding: the review page with extracted fields, start date and the three fact dropdowns           | https://aoo-web.vercel.app/admin/onboarding/new (upload a synthetic letter; don't press Start) |
| S4  | Morgan, Overview: header, **start-date strip** ("Starts in …", "Access set up in") and Tools and access  | https://aoo-web.vercel.app/admin/onboarding/84181a2c-5a72-43b9-9ed3-eadb06e0de2a               |
| S5  | Same, one Okta row's **Why** opened, with "Okta login" and "Status: STAGED"                              | same page                                                                                      |
| S6  | Completed hire, **Plan** tab                                                                             | https://aoo-web.vercel.app/admin/onboarding/f11dc8ba-42c3-4aba-8e54-071ff458b11e?tab=plan      |
| S7  | Morgan, **Activity** tab                                                                                 | https://aoo-web.vercel.app/admin/onboarding/84181a2c-5a72-43b9-9ed3-eadb06e0de2a?tab=activity  |
| S8  | Morgan, **Audit & technical** tab (Role Access Agent, policy decisions with catalog 1.1.0 / rules 1.2.0) | https://aoo-web.vercel.app/admin/onboarding/84181a2c-5a72-43b9-9ed3-eadb06e0de2a?tab=technical |
| S9  | Jordan Rivera, **Activity** tab: "Operator retried a failed resource" and the replaced approval ticket   | https://aoo-web.vercel.app/admin/onboarding/aa97136e-845e-4e03-b73e-63fb9ebbe516?tab=activity  |
| S10 | Landing, "What a real run looked like"                                                                   | https://aoo-web.vercel.app (scroll)                                                            |
| S11 | The **Workflows** list: summary counts, "Starts …" under each hire, "Needs attention"                    | https://aoo-web.vercel.app/admin/onboarding                                                    |
| S12 | Morgan's **GitHub account** page (username field with the invitation warning)                            | https://aoo-web.vercel.app/admin/onboarding/84181a2c-5a72-43b9-9ed3-eadb06e0de2a/github        |
| S13 | A tool with no API: "Set up Cursor license" with the **How was it set up?** box                          | see the note below                                                                             |

Note for S3: starting an onboarding counts toward your account's one per day. Screenshot the review page without pressing **Start onboarding**.

Note for S13: none of the current production hires has a tool waiting for manual setup. If you start one onboarding (a full-time engineer whose job description mentions AI-assisted coding in Cursor), the AI will likely suggest the Cursor license; once the worker runs (weekdays 09:00–16:59 Phoenix time) the hire's Overview shows **Set up Cursor license** with the form. Screenshot that without submitting. If you skip it, describe it over S4.

**Provider consoles** (take these yourself; sign in to each sandbox first):

| #   | Picture                                                                                  | Where                                                                                                          |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P1  | Okta: Morgan's profile (Staged, employee number `OFFER-BE0E3ADCA8354772`)                | Okta Admin → Directory → People → search "Morgan Vale"                                                         |
| P2  | Okta: AOO Slack Engineering Test and AOO AWS Development Test, Morgan listed as a member | Okta Admin → Directory → Groups                                                                                |
| P3  | ServiceNow: the access request list filtered to Morgan's workflow (exactly two records)  | https://dev385843.service-now.com/x_2230066_autono_0_onboarding_access_request_list.do (filter on Workflow id) |
| P4  | ServiceNow: `OAR0001009`, approval request, **Approved**, with the AI's reason           | same list                                                                                                      |
| P5  | ServiceNow: `OAR0001010`, fulfillment request, **Fulfilled**                             | same list                                                                                                      |
| P6  | ServiceNow: the app's roles and access rules (least privilege)                           | System Security → Roles / Access Control, filtered to the app scope                                            |
| P7  | GitHub: `aoo-sandbox` members and the audit log ("Invited …", "Added … to the team")     | https://github.com/orgs/aoo-sandbox                                                                            |

Sign in to the ServiceNow developer portal before recording so the instance is awake (a sleeping instance takes a few minutes to start).

---

## The script

| #   | Scene                           | Pictures                 | Time   |
| --- | ------------------------------- | ------------------------ | ------ |
| 1   | Why this problem                | S1                       | 0:45   |
| 2   | Who the users are               | S2                       | 0:30   |
| 3   | The operator's home             | S11                      | 0:25   |
| 4   | Two ways in                     | S3                       | 0:40   |
| 5   | AI suggests, rules decide       | S4, S5                   | 0:45   |
| 6   | Versioned rules you can replay  | S8                       | 0:25   |
| 7   | Okta: the everyday tools        | S5, P1, P2               | 0:35   |
| 8   | GitHub                          | S12, P7                  | 0:35   |
| 9   | ServiceNow: production access   | P3, P4, P5               | 0:50   |
| 10  | Tools with no API               | S13                      | 0:25   |
| 11  | Plan, activity and audit        | S6, S7, S8               | 0:30   |
| 12  | AI tested, not just used        | slide                    | 0:40   |
| 13  | When something breaks           | S4 (GitHub row), S9, S10 | 0:40   |
| 14  | Security and operations         | slide + P6               | 0:40   |
| 15  | Impact and ROI I expect         | slide                    | 0:45   |
| 16  | Key tech choices and trade-offs | slide                    | 0:50   |
| 17  | Close                           | S1                       | 0:15   |
|     |                                 |                          | ≈10:15 |

Trim scenes 6 or 12 if you run long.

### Scene 1: Why this problem (S1) · 0:45

> "At two jobs in a row I spent my first weeks waiting for access. At my current role, it took four weeks to finish onboarding. Nobody was slow on purpose: access is spread across HR, IT, managers and approvers, every tool has its own request, and no one has a single view of what's still missing.
>
> It's common. In Ivanti's survey of over 400 IT professionals, just 15% of employees have everything they need on day one, and 27% of IT teams say it takes more than a week. In BambooHR's survey of 1,500 US employees, 58% name lack of access to essential tools among their biggest onboarding frustrations.
>
> So I built Swift."

Sources for the description or an end card:

- Ivanti (September 2019): https://www.ivanti.com/company/press-releases/2019/survey-85-of-employees-don-t-have-all-the-resources-they-need-on-day-one-to-do-their-job
- BambooHR: https://www.bamboohr.com/resources/guides/the-definitive-guide-to-successfully-onboarding-your-new-employees/

### Scene 2: Who the users are (S2) · 0:30

> "Swift is for the HR and IT people who onboard new hires, and the people they wait on. HR or IT uploads the signed offer letter and makes a few decisions. Approvers decide sensitive access in ServiceNow, where they already work. IT fulfills what can't be automated. The new hire never logs in to Swift; they just get their accounts and a first-month plan."

### Scene 3: The operator's home (S11) · 0:25

> "This is where an HR or IT person starts their day: every hire, their start date, where each one is, and what needs attention, in plain words. No digging through tickets to find out who's waiting on what."

### Scene 4: Two ways in (S3) · 0:40

> "Onboarding starts in one of two ways. A real HR system can send a signed event when an offer is signed and the candidate is cleared; it's verified, protected against replays, and sending it twice never creates a second hire.
>
> Or an operator uploads the signed offer letter. An AI extractor proposes the hire's details: name, email, title, manager, start date and a short duty summary. It removes salary and personal numbers, and Swift never stores the PDF. The operator confirms the start date, so Swift can show whether access is ready in time.
>
> Either way, the three facts that drive access, department, role family and employment type, come from the HR system or a person. The AI never sets them."

### Scene 5: AI suggests, rules decide (S4, then S5) · 0:45

> "Here's a real hire on production, Morgan, starting in a few weeks. An agent read the role and job description and suggested seven tools, only from a fixed catalog. Then deterministic access rules decided each tool on its own: six allowed, one sent to a person for approval. Tools that depend on others wait for them, but unrelated tools never wait.
>
> At the top: the start date, and how long access took. Okta, Jira, Slack and AWS development were ready about thirty seconds after the onboarding started, with nobody involved." _(S5)_ "Every tool has a 'Why': what the AI suggested and the exact rule that decided it. The AI can recommend; it can never grant."

### Scene 6: Versioned rules you can replay (S8) · 0:25

> "The catalog and the rules are released as versions, each pinned by a fingerprint. Every decision records which version made it: Morgan's say catalog 1.1.0 and rules 1.2.0. When I moved Slack and AWS development to Okta, older onboardings kept their versions, and a test proves the new rules decide everything exactly as before."

### Scene 7: Okta, the everyday tools (S5, P1, P2) · 0:35

> "Everyday tools go through Okta groups: the engineering group, Jira, Slack through single sign-on, and AWS development through IAM Identity Center. Swift creates the person's Okta account, adds the groups the rules allowed, and confirms each membership with Okta. It looks people up before creating them, so there are never duplicates.
>
> _(P1)_ The account is staged: Swift doesn't activate it and never sets a password. Activation is a separate step, ideally on the start date, which emails the employee to set their own."

### Scene 8: GitHub (S12, P7) · 0:35

> _(S12)_ "HR records the hire's GitHub username here. Swift warns that a real invitation will go to that account.
>
> _(P7)_ Swift resolves the username to GitHub's permanent account ID and invites that exact account to the organization, so only the real owner can accept. Team access waits for the acceptance; Swift adds members, never admins, and it never removes anything. Running it twice never invites anyone twice."

### Scene 9: ServiceNow, production access (P3, P4, P5) · 0:50

> _(P3)_ "Only sensitive access reaches ServiceNow. For Morgan there are exactly two records, both for AWS production, and none for Slack or AWS development.
>
> _(P4)_ First an approval. An approver decided in ServiceNow; ServiceNow notified Swift, and Swift read the ticket back before acting. It never trusts the message alone. A rejection would simply leave that one tool not granted.
>
> _(P5)_ Then, separately, a fulfillment request for IT, opened only after the approval and after AWS development was ready. Swift marked AWS production ready only when ServiceNow said it was fulfilled: eleven minutes after the start, including both human steps."

### Scene 10: Tools with no API at all (S13) · 0:25

> "Some tools have no API and no ServiceNow process, like a license someone assigns in a vendor's console. Swift doesn't pretend: it asks the operator to set it up and mark it done, with a short note on how. That confirmation is recorded like everything else, and Swift carries on."

### Scene 11: Plan, activity and audit (S6, S7, S8) · 0:30

> _(S6)_ "When every tool is settled, a second agent writes a first-month plan, and it may only mention tools the person actually has. This one is from an earlier completed hire." _(S7)_ "The activity shows each step in plain language." _(S8)_ "And the technical view records every suggestion, decision, approval and change, with who made it, so any decision can be explained."

### Scene 12: AI tested, not just used (slide) · 0:40

Slide:

| AI component           | Evaluation                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Role Access Agent      | 9 cases on the real model: 100% valid output, 0 invented tools, every required tool found; a prompt-injection case returned nothing             |
| Onboarding Plan Agent  | 10 cases: 100% valid, 0 references to tools the person doesn't have, 0 invented links, emails, times or people, 2 prompt-injection cases passed |
| Offer Letter Extractor | 9 letters, 9 of 9 passed: 0 leaks of salary, bonus, phone, address or injected instructions                                                     |

> "I didn't just wire up a model. Each AI piece has an evaluation set run against the real model, including hostile cases: a job description that tries to grant itself admin access, and an offer letter that tells the AI to ignore its instructions. The outputs are checked against strict schemas, and anything outside the rules is rejected, never quietly fixed."

### Scene 13: When something breaks (S4 GitHub row, S9, S10) · 0:40

> _(S4, Morgan's GitHub row)_ "Some things are refused on purpose: one GitHub account can never be attached to two people. The sandbox has a single test account, already linked to another hire, so Swift stops and says why, and Morgan's onboarding waits rather than guessing.
>
> _(S9)_ And some things go wrong. ServiceNow reset my developer instance, so Jordan's Slack request failed and an approval ticket vanished. The operator pressed Retry, and Swift opened a fresh request; for the approval, Swift first confirmed with ServiceNow that the old ticket was gone, then opened a new one. Nothing was repeated, and everything is in the record.
>
> _(S10)_ In an earlier production run, it also stopped on an Okta group I'd forgotten to configure. Once I fixed it, the next scheduled run carried on from where it stopped."

### Scene 14: Security and operations (slide, with P6) · 0:40

Slide:

- **Least privilege:** Swift's ServiceNow account can only create and read requests; the fulfiller can change one field.
- **Every incoming message is signed** (HR events, ServiceNow callbacks, the scheduler) and replay-protected.
- **Operators:** passwords hashed, accounts lock after 5 wrong tries, logging out ends the session on the server, no secret ever reaches the browser, daily limits per account.
- **Durable by design:** every change and its follow-up are saved together; retries with backoff; failures land in a visible queue; operators can retry a failed tool; optional tracing from request to worker.

> "Under the hood it's built like production software: least privilege in every system, signed and replay-protected messages, and a workflow that survives crashes and redeploys without losing or repeating work. I sent extra worker runs after Morgan's access was set up: no new accounts, memberships or tickets."

### Scene 15: Impact and ROI I expect (slide or S4) · 0:45

> "This is a proof of concept, so I'm not claiming measured savings. Here's what I expect to change, and what a pilot would measure before and after:
>
> - **Time to required access:** seconds for the everyday tools, as Morgan's page shows. Approvals still take as long as the approver.
> - **Manual IT work per hire:** one upload and a few decisions, instead of a ticket per tool.
> - **Fewer mistakes:** access comes from versioned rules, not memory, and nothing is granted that the rules don't allow.
> - **Visibility:** one page shows the start date, who is waiting on what, and how long it took."

Optional on a slide (a formula, not a result):

```
annual value ≈ hires per year × (waiting hours removed per hire × new hire's loaded cost
                                 + IT hours saved per hire × IT loaded cost)
```

### Scene 16: Key tech choices and trade-offs (slide) · 0:50

Put this table on a slide and talk through three or four rows.

| Choice                                                            | Why                                                                              | Trade-off                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| AI suggests, versioned rules decide                               | Access decisions must be explainable and repeatable; the AI can't grant anything | Someone maintains the rules; today they decide by department, role family and employment type |
| AI limited to a fixed catalog, strict structured output, no tools | It can't invent a tool or take an action                                         | New tools need a catalog release                                                              |
| Everyday tools through Okta groups                                | No person in the loop for routine access                                         | Each tool needs its group mapped in the identity provider                                     |
| Each tool handled on its own                                      | One slow approval never blocks the rest                                          | More state to track per hire                                                                  |
| Own durable workflow on PostgreSQL + outbox, not Temporal         | Survives crashes and redeploys with one database, on free tiers                  | More code to own and test                                                                     |
| Check before every write, confirm after                           | Retries never create a second account or ticket                                  | Extra reads against each provider                                                             |
| ServiceNow for the human steps                                    | Approvers and IT stay in the tool they already use                               | Setup in ServiceNow                                                                           |
| Vercel Hobby + Neon + a scheduler                                 | A real public deployment at no cost                                              | The worker runs on weekday business hours only                                                |

> "Built with Next.js, Fastify and TypeScript, PostgreSQL, OpenAI for two agents and one extractor, and real ServiceNow, Okta and GitHub sandboxes; 844 unit tests and 380 integration tests."

### Scene 17: Close (S1) · 0:15

> "Swift turns a signed offer into ready access and a first-month plan, with people deciding only what needs a person. Next I'd activate accounts on the start date, add finance and sales tools to the catalog, handle role changes and offboarding, connect a real HR system, and run a pilot to measure time to access. Thanks for watching."

---

## Keep it accurate

- Morgan's onboarding is waiting on GitHub (the sandbox's single test account is linked to another hire), so it has no plan yet; show the plan from the completed hire and say so.
- Don't claim measured savings or "four weeks to minutes" as a result; "about thirty seconds" is the measured time for Morgan's Okta tools, not a pilot result.
- Don't say the rules read the job description; the AI does, and the rules decide by department, role family and employment type.
- Don't say Swift provisions tools that aren't in the catalog (for example QuickBooks or Lucidchart).
- Don't say Swift activates Okta accounts or sets passwords: accounts stay Staged.
- Don't say the Okta configuration problem fixed itself: it stopped safely and resumed after you fixed the configuration.

## If you're asked about gaps

- Okta accounts aren't activated on the start date; they stay Staged.
- GitHub in the sandbox has one test account, so only one hire can complete GitHub access.
- No offboarding or role-change handling yet.
- No SSO or roles: every account is a full operator (a proof-of-concept choice, with daily limits).
- The catalog is mostly engineering tools; finance and sales tools would be the next catalog release.
