# Production deployment (M10)

Vercel Hobby (three projects) + Neon PostgreSQL + Upstash QStash Free, with the existing
ServiceNow PDI, Okta and GitHub sandboxes and the OpenAI API. Variable **names only** below:
values live in Vercel (Production environment, marked _Sensitive_) or in the git-ignored local
`.env`, never in the repository.

```
                         VERCEL HOBBY
   ┌──────────────────────────────────────────────────────────┐
   │ aoo-web    (apps/web)     Next.js: landing, /demo, operator dashboard
   │ aoo-api    (apps/api)     Fastify as one Vercel Function: webhooks + operator API
   │ aoo-worker (apps/worker)  bounded worker Function: POST /api/worker/run
   └──────────────────────────────────────────────────────────┘
          ▲ signed QStash request (Mon–Fri 09:00–16:59, every minute)
   Upstash QStash Free ── only the clock; owns no state, no jobs
          │
   Neon PostgreSQL ── workflow state, transactional outbox, audit (system of record)
          │
   ServiceNow PDI · Okta · GitHub · OpenAI (called only by the worker's adapters/agents)
```

## Scheduling decision

Vercel Hobby's native Cron runs at most once per day, which is insufficient for interactive
background orchestration. Production therefore uses **Upstash QStash only as a signed
business-hours scheduler**: one schedule invokes the bounded worker Function every minute from
09:00 through 16:59, Monday–Friday, in `AOO_BUSINESS_TIMEZONE` (`America/Phoenix`).
PostgreSQL remains the durable workflow/outbox source of truth.

| Budget item                           | Value                                    |
| ------------------------------------- | ---------------------------------------- |
| Cron                                  | `CRON_TZ=America/Phoenix * 9-16 * * 1-5` |
| Scheduled deliveries per business day | 8 h × 60 = **480**                       |
| QStash retries per delivery           | **1** (transport retry only)             |
| Worst case per day                    | 480 × 2 = **960**                        |
| QStash Free limit                     | 1000 messages/day (each retry counts)    |
| Destination timeout                   | 300 s                                    |

- The public application (landing, demo, operator login/dashboard, API, signed HRIS webhook,
  ServiceNow callbacks) is available **24/7**. Only automated worker execution is
  business-hours.
- **Off-hours work is never lost:** an HRIS event at 17:30 is verified and committed (workflow +
  outbox) and the API returns 202; the work waits in Neon and resumes at the next scheduled run.
  The same holds for approval/fulfillment callbacks and HR GitHub-username recording. The
  dashboard shows the queued state.
- The worker has no wall-clock rule: an authenticated delivery runs at any time
  (`pnpm qstash:worker:wake --confirm` publishes one signed delivery for testing/demos).
- A QStash outage or exhausted quota only delays processing; nothing is corrupted.
- Do not add further recurring schedules without recalculating the budget.

## Worker Function

- `POST /api/worker/run`: method → raw body (≤ 4 KiB) → **QStash signature** (official
  `@upstash/qstash` Receiver; current _or_ next signing key, issuer, subject =
  `WORKER_QSTASH_URL`, SHA-256 of the exact raw body, exp/nbf) → `runWorkerBatch`. Unauthorized:
  `401 {"error":"UNAUTHORIZED"}` with no database, provider or model work.
- `runWorkerBatch({ maxEvents, deadlineMs })`: due sweeps, then outbox batches until no
  immediately runnable work (chains A → B → C drain in one run), the event budget
  (`WORKER_RUN_MAX_EVENTS`, 500) or the deadline. No unbounded loop; delayed work (retry
  backoff, human waits) stays in PostgreSQL.
- Durations: `maxDuration` 300 s (Hobby max); claiming stops at `WORKER_RUN_DEADLINE_MS`
  (230 s). Config refuses `deadline + longest handler + 10 s > 300 s`; the longest handler is
  `max(1.3 × OUTBOX_LEASE_MS, 0.8 × ONBOARDING_PLAN_RUN_LEASE_MS)` (production:
  `ONBOARDING_PLAN_RUN_LEASE_MS=60000` → 48 s).
- Outbox leases are renewed by a heartbeat (every lease/3) while a handler runs; a killed
  instance stops renewing, its leases expire, and the next run recovers the work.
- No `CRON_SECRET`: QStash signature verification is the endpoint's only authentication.

## Projects

| Project      | Root directory | Framework | Function                   | Production URL                |
| ------------ | -------------- | --------- | -------------------------- | ----------------------------- |
| `aoo-web`    | `apps/web`     | Next.js   | (Next.js)                  | https://aoo-web.vercel.app    |
| `aoo-api`    | `apps/api`     | Other     | `api/index.js`, 60 s       | https://aoo-api.vercel.app    |
| `aoo-worker` | `apps/worker`  | Other     | `api/worker/run.js`, 300 s | https://aoo-worker.vercel.app |

Each `vercel.json` installs from the monorepo root (`pnpm@12.5.1 install --frozen-lockfile`) and
builds only the app and its workspace dependencies (`pnpm --filter <app>... build`). Node
`24.x`. The root `.vercelignore` keeps `.env*`, `dist`, `.next` and `node_modules` out of every
CLI upload. Docker Compose is unchanged for local development.

## Environment matrix (Production only)

S = secret (Vercel _Sensitive_). Preview and Development environments get **none** of these
secrets, so preview deployments cannot reach real data or providers (and fail closed).

| Variable                                                                                            | web | api | worker | S   |
| --------------------------------------------------------------------------------------------------- | --- | --- | ------ | --- |
| `AOO_ENVIRONMENT=production`                                                                        | ✓   | ✓   | ✓      |     |
| `API_BASE_URL=https://aoo-api.vercel.app`                                                           | ✓   |     |        |     |
| `ONBOARDING_ADMIN_TOKEN`                                                                            | ✓   | ✓   |        | S   |
| `DATABASE_URL` (Neon pooled; injected by the Neon integration)                                      |     | ✓   | ✓      | S   |
| `HRIS_WEBHOOK_SECRET`                                                                               |     | ✓   |        | S   |
| `SERVICENOW_CALLBACK_SECRET`                                                                        |     | ✓   |        | S   |
| `SERVICENOW_CALLBACK_INSTANCE`, `SERVICENOW_CALLBACK_TABLE`                                         |     | ✓   |        |     |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`                                             |     |     | ✓      | S   |
| `WORKER_QSTASH_URL=https://aoo-worker.vercel.app/api/worker/run`                                    |     |     | ✓      |     |
| `ONBOARDING_PLAN_RUN_LEASE_MS=60000`, `OUTBOX_BATCH_SIZE=5`                                         |     |     | ✓      |     |
| `SERVICENOW_INSTANCE_URL`, `SERVICENOW_ACCESS_REQUEST_TABLE`, `SERVICENOW_TIMEOUT_MS=5000`          |     |     | ✓      |     |
| `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD` (integration account)                                  |     |     | ✓      | S   |
| `PROVISIONING_SERVICENOW_FULFILLMENT_ENABLED`, `ONBOARDING_PLAN_GENERATION_ENABLED` (start `false`) |     |     | ✓      |     |
| `GITHUB_TOKEN`                                                                                      |     |     | ✓      | S   |
| `GITHUB_ORG`, `GITHUB_BACKEND_TEAM_SLUG/NAME`, `GITHUB_FRONTEND_TEAM_SLUG/NAME`                     |     |     | ✓      |     |
| `OKTA_API_TOKEN`                                                                                    |     |     | ✓      | S   |
| `OKTA_BASE_URL`, `OKTA_ENGINEERING_GROUP_ID/NAME`, `OKTA_JIRA_ENGINEERING_GROUP_ID/NAME`            |     |     | ✓      |     |
| `OKTA_SLACK_ENGINEERING_GROUP_ID/NAME`, `OKTA_AWS_DEV_GROUP_ID/NAME` (catalog 1.1.0, M14)           |     |     | ✓      |     |
| `OPENAI_API_KEY` (api: Offer Letter Extractor; worker: the two agents)                              |     | ✓   | ✓      | S   |
| `OPENAI_MODEL`                                                                                      |     | ✓   | ✓      |     |
| `OFFER_LETTER_INTAKE_ENABLED=true` (M11)                                                            |     | ✓   |        |     |
| `ROLE_ACCESS_AGENT_ENABLED=true`, `ROLE_ACCESS_RUN_LEASE_MS=60000` (M10)                            |     |     | ✓      |     |

Never in any Vercel runtime project: `QSTASH_TOKEN` (schedule management only, local `.env`),
`SERVICENOW_SCHEMA_*`, `SERVICENOW_FULFILLER_*`, `GITHUB_TEST_USERNAME`. Never a
`NEXT_PUBLIC_*` variable.

Production startup refuses the public development defaults (`dev-only-…`) for
`HRIS_WEBHOOK_SECRET`, `ONBOARDING_ADMIN_TOKEN` and `SERVICENOW_CALLBACK_SECRET`
(`AOO_ENVIRONMENT=production` or `VERCEL_ENV=production`), naming only the variable.

## Deploy order

1. Neon `aoo-production` via the Vercel Marketplace integration, connected to `aoo-api` and
   `aoo-worker` (Production only). Verify `SELECT 1`.
2. Migrate (below), before any code that needs the schema serves traffic.
3. Secrets per the matrix (Production only); providers and plan generation start disabled.
4. Deploy `aoo-api`, then `aoo-worker`, then `aoo-web` (`vercel deploy --prod` from the repo
   root with `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` of the project; no Git push needed).
5. Verify: health endpoints, unauthorized worker run → 401, signed wake → 200.
6. ServiceNow global properties `aoo.approval_callback.url` →
   `https://aoo-api.vercel.app/webhooks/servicenow/approvals` and `aoo.fulfillment_callback.url`
   → `https://aoo-api.vercel.app/webhooks/servicenow/fulfillment` (set manually in the PDI; no
   new update set).
7. `pnpm qstash:schedule:check`, `pnpm qstash:schedule:apply --confirm`, check again.
8. Read-only provider preflights (`pnpm servicenow:check`, `okta:check`, `github:check`), then
   enable providers and plan generation in Production only.

## Migrations (explicit; never in a build)

```sh
vercel env pull /path/outside/repo/aoo-prod.env --environment=production   # aoo-worker project
pnpm db:migrate:production --env-file /path/outside/repo/aoo-prod.env           # dry run
pnpm db:migrate:production --env-file /path/outside/repo/aoo-prod.env --confirm
rm /path/outside/repo/aoo-prod.env
```

Uses `DATABASE_URL_UNPOOLED` (direct) when present, else `DATABASE_URL`; refuses an env file
inside the repository; prints counts only. Never edit an applied migration; add new ones. Production is at `0019_operator_session_revocations` (20 migrations).

## External route and security matrix

| Category               | Routes                                                                                                                                                                                                            | Protection                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUBLIC                 | web `/`, `/demo`, `/demo/{completed,awaiting-approval,github-invitation-pending}`, `/admin/onboarding/login`, `/admin/onboarding/signup` (M12: anyone may create an operator account); api `GET /resources[/:id]` | read-only; demo is synthetic, bundled, identifier-free, fixed slugs (others 404)                                                                      |
| AUTHENTICATED_OPERATOR | web `/admin/onboarding/**` (session cookie: HttpOnly, SameSite=Strict, Secure, 30 min); api `/admin/**` incl. `POST /admin/operator-sessions/revoke` (Bearer)                                                     | constant-time token check before any database access; logged-out sessions refused server-side (`X-Operator-Session`); same-origin form posts; no CORS |
| SIGNED_WEBHOOK         | api `POST /webhooks/hris` (HMAC over timestamp + raw body, 5 min window), `POST /webhooks/servicenow/{approvals,fulfillment}` (HMAC, 5 min)                                                                       | verified before parsing; durable de-duplication; nothing written on rejection                                                                         |
| QSTASH_SIGNED          | worker `POST /api/worker/run`                                                                                                                                                                                     | QStash Receiver (current/next key, subject, body hash, exp/nbf) before any work                                                                       |
| HEALTH                 | api `GET /health`, web `GET /api/health`, worker `GET /api/health`                                                                                                                                                | liveness only; no database, configuration or secret detail                                                                                            |

Lightweight abuse protection: body limits (HRIS 64 KiB, callbacks 16 KiB, worker 4 KiB),
fixed-format error bodies, no stack traces, operator accounts with salted scrypt password hashes, generic sign-in failures and a 15-minute lock after 5 failures (M12), the internal web→API token compared in constant time, Vercel's
platform DDoS mitigation. The API sets no CORS headers (browsers cannot call it cross-origin);
the web app sends `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`,
`Referrer-Policy: same-origin` (not `no-referrer`: that makes browsers send `Origin: null` on same-site form posts, which the login's same-origin check correctly refuses), and `noindex` + `no-store` on `/admin`.

## Known limitations

- QStash Free (1000 messages/day) and Vercel Hobby (300 s functions, hobby usage limits) are
  demo-grade; outside business hours nothing is processed automatically.
- (M12) Self-registered operator accounts (email + password, no email verification, no SSO); every account is a full operator, capped at 20 new accounts and 30 offer-letter uploads (3 per account) per day; Basic auth to ServiceNow; API tokens for Okta/GitHub.
- No preview database: preview deployments have no secrets and fail closed.
