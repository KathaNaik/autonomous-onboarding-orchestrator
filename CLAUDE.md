# Autonomous Onboarding Orchestrator

This system automates employee onboarding. It starts when an HRIS event confirms that a new hire has signed an offer and been cleared. It then provisions identity, groups and access, including engineering access. Humans approve requests through ServiceNow.

It is a pnpm + TypeScript monorepo, built in milestones (see **Milestone workflow**). Only build what the current milestone asks for.

## Current status

| Milestone | Scope                                                                                                                                                                          | Status                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| M1        | Monorepo scaffold: Fastify API, Next.js web, shared Zod schemas, Vitest, Docker Compose, health endpoints, smoke tests                                                         | Complete (accepted)                                                                              |
| M2        | Persistent workflow engine: PostgreSQL, Drizzle, versioned migrations, workflow state machine, `WorkflowService`, append-only audit                                            | Complete (awaiting acceptance)                                                                   |
| M3A       | Signed HRIS webhook (`POST /webhooks/hris`), HMAC auth, HRIS simulator, event receipts, transactional outbox writes                                                            | Complete (awaiting acceptance)                                                                   |
| M3B       | Durable local outbox worker: SKIP LOCKED claiming, leases with fencing, retries with backoff and jitter, dead-letter plus redrive, workflow start (RECEIVED → ACCESS_PLANNING) | Verified (ready for acceptance)                                                                  |
| M4A       | ServiceNow PDI setup, scoped app + table, read-only Table API adapter (`@aoo/servicenow`), explicit live test, update-set export                                               | **Complete (accepted).** Verified live against PDI `dev225201` (see **M4A verification record**) |
| M4B       | Not yet defined; the user defines it when starting it                                                                                                                          | Not started                                                                                      |

What exists today: the M1 scaffold, the M2 database and workflow engine (see **Workflow engine**), the M3A signed HRIS webhook (see **HRIS webhook**), and the M3B outbox worker (see **Outbox worker**). The worker is a separate process that starts each newly created workflow (`RECEIVED → ACCESS_PLANNING`). M4A adds a **read-only** ServiceNow Table API adapter (see **ServiceNow adapter**), which nothing calls yet. **Nothing drives a workflow past `ACCESS_PLANNING` yet. No ServiceNow writes (tickets, approvals), agents, policy engine, resource catalog, per-resource access execution, Okta or GitHub integrations, AWS infrastructure or frontend features exist yet.** Everything under **Confirmed architecture** below is decided but, unless marked "in place", not built. Build each piece only when a milestone asks for it.

## Confirmed architecture

These decisions are fixed. Changing any of them needs an explicit decision from the user, recorded here first.

### Platform (in place since M1)

- **Package manager:** pnpm 12 workspaces (`pnpm-workspace.yaml`). Version pinned in `packageManager`.
- **Runtime:** Node 24 (`.nvmrc`, Docker base image `node:24-alpine`). All packages are ESM (`"type": "module"`).
- **Language:** TypeScript 7, strict. Shared compiler settings live in `tsconfig.base.json`.
- **API:** Fastify 5 in `apps/api`.
- **Web:** Next.js 16 App Router in `apps/web`, built with `output: "standalone"`.
- **Contracts:** Zod 4 schemas in `packages/shared` (`@aoo/shared`). This is the single source of truth for every shape that crosses a process boundary.
- **Tests:** Vitest 5, run from the root using `projects` (`vitest.config.ts`).
- **Containers:** one multi-target `Dockerfile` (`--target api|web|migrate`) and `docker-compose.yml`.

### Backend shape

- **Modular monolith.** The backend is one deployable made of internal modules with explicit interfaces. There are no microservices. Modules talk to each other through their public interfaces, never through each other's tables or internals.
- **Custom durable workflow orchestrator, written in TypeScript.** Onboarding runs as a workflow. Its state is persisted in PostgreSQL, so a workflow survives restarts and resumes where it stopped. The initial architecture does not use Temporal, Step Functions or Inngest. This is a present choice, not a permanent ban. Adopting one later requires an explicit user decision recorded here.
- **The orchestrator owns persistence and execution.** It is the only component that writes workflow state and the only one that invokes provisioning adapters.

### Database

- **PostgreSQL** is the only system of record.
- **Drizzle ORM** handles queries and schema definitions.
- **Versioned SQL migrations:** generated or written as SQL files, committed to the repo and applied in order. Never change a migration that has already been applied; add a new one instead.
- Workflow state, the outbox, idempotency records and the audit log all live in PostgreSQL.
- **In place since M2:** PostgreSQL 18, Drizzle ORM with the `pg` driver, and migrations in `packages/db/migrations/`. Drizzle's migrator records applied migrations in `drizzle.__drizzle_migrations`.

#### Migrations

| Task                                                                             | Command                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Generate a migration from schema changes (`packages/db/src/schema.ts`)           | `pnpm db:generate --name <change>`                                       |
| Create an empty migration for hand-written SQL (triggers, functions, data fixes) | `pnpm --filter @aoo/db db:generate:custom --name <change>`               |
| Apply pending migrations to `DATABASE_URL`                                       | `pnpm db:migrate`                                                        |
| Apply migrations in Docker                                                       | `docker compose up migrate` (one-shot; runs after `postgres` is healthy) |

- Commit the `.sql` files **and** `migrations/meta/` (journal + snapshots) together. Never edit either by hand after the migration has been applied anywhere. Prettier ignores this directory.
- Review generated SQL before committing it.
- Applied migrations, in order:
  - `0000_init`: the M2 workflow tables.
  - `0001_audit_events_append_only`: hand-written. Database triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `audit_events`.
  - `0002_hris_receipts_and_outbox`: M3A. Adds `hris_event_receipts` and `outbox_events` and changes no existing table.
  - `0003_audit_occurred_at_clock_timestamp`: M3A. `audit_events.occurred_at` now defaults to `clock_timestamp()` instead of `now()`. `now()` is the transaction _start_ time, which misordered audit events written by concurrent transactions that commit in a different order than they began.
  - `0004_outbox_worker_leases_and_attempts`: M3B. Adds to `outbox_events`: `status`, `cycle_attempts`, lease columns, `dead_lettered_at`, `redrive_count`, integrity CHECKs, and a claimable index that replaces `outbox_events_unpublished_idx`. Also adds the `outbox_event_attempts` table and `audit_events.idempotency_key` (unique where not null). Additive; existing rows remain valid.

### Events

- **Transactional outbox.** A state change and the events it emits are written in the same database transaction. A separate dispatcher publishes those events afterwards.
- **Development:** a local worker process polls the outbox and delivers events.
- **In place since M3A:** the `outbox_events` table, and outbox writes in the same transaction as the change they describe (HRIS intake).
- **In place since M3B:** the local worker that claims and processes outbox rows (see **Outbox worker**). EventBridge and SQS are still future work.
- Outbox columns: `idempotency_key` (unique per logical event), `aggregate_type`/`aggregate_id`, `event_type`, `payload` (jsonb, validated against a `@aoo/shared` schema before insert), `correlation_id`, `status` (`PENDING` / `PROCESSED` / `DEAD_LETTERED`), `available_at`, `published_at` (set when delivered successfully), `attempts` (total claims ever, never reset), `cycle_attempts` (claims since creation or the last redrive), `last_error`, `lease_token` / `lease_owner` / `lease_expires_at`, `dead_lettered_at` and `redrive_count`. CHECK constraints tie `published_at` to `PROCESSED`, tie `dead_lettered_at` to `DEAD_LETTERED`, keep the lease columns all-or-nothing, and allow a lease only on a `PENDING` row.
- Outbox event types and payload schemas live in `@aoo/shared` (`OUTBOX_EVENT_TYPES`, `src/outbox.ts`).
- **Target:** AWS EventBridge for routing and SQS for consumption. The dispatcher sits behind an interface, so switching from the local worker to AWS doesn't change domain code.
- **No cloud infrastructure yet.** AWS SDKs, infrastructure-as-code and AWS credentials wait for the milestone that introduces the AWS event transport. Don't add them before then.

### AI agents: recommend only

There are exactly two agents. Don't add a third.

1. **Role Access Agent:** recommends entitlements for a hire, chosen **only from the versioned resource catalog**. It can't invent resources or recommend anything outside the catalog, and each recommendation references the catalog version it used. It does not decide whether an approval is needed.
2. **Onboarding Plan Agent:** may recommend **optional** onboarding modules and a suitable order for them. **Company rules**, not the agent, determine the required modules and their dependencies. The agent can't remove or reorder required modules in a way that breaks a rule-defined dependency.

Rules:

- Agents return **structured recommendations only**, validated against Zod schemas. They never call external APIs, never access provisioning adapters, never write to the database, and never trigger actions.
- A **deterministic policy engine** decides whether each recommendation is allowed and **whether a ServiceNow approval ticket is required**. It is the only authority on authorization. An agent's output is never an authorization.
- **Deterministic adapters** carry out approved actions against external systems. Adapters contain no LLM calls. Only the orchestrator invokes them.

### Access requests: per resource

- **Evaluate and execute each resource independently.** Each requested entitlement gets its own policy decision, its own approval (if policy requires one) and its own execution.
- **Don't block on unrelated approvals.** A resource that is authorized proceeds even while other resources for the same hire wait on approval.
- **Respect provisioning dependencies.** A resource that depends on another waits until that dependency has been provisioned. For example, a GitHub team membership waits on the Okta identity when the catalog declares that dependency.

Flow for each resource: agent recommendation (from the catalog) → policy engine decision (allow, deny or needs approval) → ServiceNow approval if policy requires it → dependencies satisfied → adapter execution.

### Workflow engine (in place since M2)

Lives in `@aoo/orchestrator`. The M2 engine is a validated, persisted state machine. It does not yet run steps automatically; later milestones drive it.

```
RECEIVED ─▶ ACCESS_PLANNING ─▶ POLICY_REVIEW ─┬─▶ AWAITING_APPROVAL ─▶ PROVISIONING
                                               └──────────────────────▶ PROVISIONING   (approval not required)
PROVISIONING ─▶ AWAITING_APPROVAL   (more resources need approval)
PROVISIONING ─▶ ONBOARDING_GENERATION ─▶ COMPLETED
any non-terminal state ─▶ FAILED    (reason required)
COMPLETED and FAILED are terminal.
```

The transition table is `WORKFLOW_TRANSITIONS` in `packages/orchestrator/src/state-machine.ts`. It is the single source of truth. The list of states is `WORKFLOW_STATES` in `@aoo/shared`, which also generates the PostgreSQL enum.

**`WorkflowService`** (`createWorkflowService(db)`). This is internal, not HTTP.

| Method                                                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createWorkflow({ employee, actor, correlationId? })`                                              | Upserts the employee by `hrisEmployeeId` and creates the workflow in `RECEIVED` at version 1, with its first step and a `workflow.created` audit event.                                                                                                                                                                                                                              |
| `getWorkflow(id)`                                                                                  | Returns `{ workflow, employee, steps }`, or `null`.                                                                                                                                                                                                                                                                                                                                  |
| `transition({ workflowId, to, expectedVersion, actor, reason?, correlationId?, idempotencyKey? })` | Validates and applies one transition, and returns the updated workflow. With `idempotencyKey` (M3B), the transition is at-most-once: if a transition with that key already committed for this workflow, it returns the current workflow and writes nothing, even though `expectedVersion` is now stale. The key is stored on the `workflow.transitioned` audit row, which is unique. |
| `listAuditEvents(workflowId)`                                                                      | Returns the audit trail in version order.                                                                                                                                                                                                                                                                                                                                            |

**Transition guarantees:**

- **Transactional:** the workflow update, step bookkeeping and `workflow.transitioned` audit event commit in one transaction, or not at all.
- **Validated:** a transition not in the table throws `InvalidTransitionError`, and nothing is written. Inputs are parsed with Zod. `FAILED` requires a `reason`. A database `CHECK` enforces that `failure_reason` is set if and only if the state is `FAILED`.
- **Concurrency:** optimistic locking on `onboarding_workflows.version`. Callers pass the `expectedVersion` they last read. The transaction takes a row lock (`SELECT … FOR UPDATE`), checks the version, and updates with `WHERE version = expectedVersion`. A stale or losing caller gets `WorkflowVersionConflictError`; it must re-read and decide again. Never retry blindly with the new version.
- Errors are typed with a stable `code`: `WORKFLOW_NOT_FOUND`, `INVALID_TRANSITION`, `WORKFLOW_VERSION_CONFLICT`, `IDEMPOTENCY_KEY_CONFLICT` (a key already used for another workflow).
- **Replay check order:** after taking the row lock, the idempotency check runs **before** the version check, because a retry after a committed transition necessarily carries a stale version.

**Tables:**

| Table                   | Purpose                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `employees`             | Hires, unique by `hris_employee_id`.                                                                                                                                                                                                                                                                               |
| `onboarding_workflows`  | One row per onboarding: `state`, `version` (concurrency token), `failure_reason`, `completed_at`. Foreign key to `employees`.                                                                                                                                                                                      |
| `workflow_steps`        | Units of work: `step_key`, nullable `subject_key`, `status` (`RUNNING` / `SUCCEEDED` / `FAILED`), `attempt`, `error` and timing fields. Foreign key to `onboarding_workflows`.                                                                                                                                     |
| `audit_events`          | Append-only history: actor, from/to state, resulting `workflow_version`, `correlation_id` and `payload` (jsonb). Foreign key to `onboarding_workflows` (nullable, for future non-workflow events).                                                                                                                 |
| `hris_event_receipts`   | (M3A) One row per accepted HRIS event: `event_id` (unique, HRIS-assigned), `event_type`, `hris_employee_id`, full `payload`, `payload_sha256`, `workflow_id` (FK), `workflow_created`, `received_at`.                                                                                                              |
| `outbox_events`         | (M3A, extended in M3B) Transactional outbox; see **Events**.                                                                                                                                                                                                                                                       |
| `outbox_event_attempts` | (M3B) One row per claim: `attempt_number`, `worker_id`, `lease_token` (unique), `claimed_at`, `lease_expires_at`, `finished_at`, `outcome` (`SUCCEEDED` / `FAILED` / `DEAD_LETTERED` / `LEASE_EXPIRED`; NULL while in flight), `error` and `detail` (jsonb: the handler result, or the error with `retryDelayMs`). |

Every table has a UUID primary key and `timestamptz` timestamps. All foreign keys are `ON DELETE RESTRICT`, so history is never cascaded away.

**Designed for per-resource progress (not built yet):**

- The workflow `state` is an **aggregate phase, not a global gate.** `PROVISIONING ⇄ AWAITING_APPROVAL` may alternate, so authorized resources provision while others wait. No workflow-level column records a single approval.
- In M2, each phase is one step (`step_key` = the state, `subject_key` = NULL). Per-resource work adds steps with `subject_key` set (for example, a catalog entitlement), each with its own status and attempts. A partial unique index allows at most one `RUNNING` step per (workflow, step_key, subject_key).
- The per-resource access-request table and its state machine, per-resource approvals and dependency ordering come in later milestones. They are added as new tables and migrations that reference `onboarding_workflows`.

### HRIS webhook (in place since M3A)

`POST /webhooks/hris` on the API. It accepts a simulated HRIS `offer.signed` event and is the only way a workflow starts.

**Request:**

- Header `X-HRIS-Signature: sha256=<hex>`: HMAC-SHA256 of the **exact raw request body**, keyed with `HRIS_WEBHOOK_SECRET`. The protocol lives in `@aoo/webhooks` (`signHrisPayload`, `verifyHrisSignature`, using a constant-time compare).
- `Content-Type: application/json`. The body is capped at `HRIS_WEBHOOK_BODY_LIMIT_BYTES` (default 64 KiB).
- Body: `HrisOfferSignedEventSchema` (`@aoo/shared`). Fields: `eventId`, `eventType: "offer.signed"`, `occurredAt` (ISO 8601), `employeeId`, `employee { firstName, lastName, email }`, `role`, `department`, `managerId`, `offerStatus` (`SIGNED|PENDING|DECLINED|RESCINDED`) and `candidateStatus` (`CLEARED|PENDING|NOT_CLEARED`). Unknown fields are stripped.

**Processing order:** raw-body HMAC check → content type → JSON parse → Zod validation → eligibility → one database transaction → response. Nothing is persisted for a request rejected before the transaction.

**Responses:** the body is `HrisWebhookAcceptedResponseSchema` or `HrisWebhookErrorResponseSchema`.

| Status | Meaning                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `202`  | Accepted: `{ status: "accepted", eventId, workflowId, workflowCreated, duplicate }`. Sent **only after the transaction commits**. A redelivery of an accepted event also gets `202`, with `duplicate: true` and the original `workflowId`. |
| `401`  | `SIGNATURE_MISSING` / `SIGNATURE_INVALID`.                                                                                                                                                                                                 |
| `415`  | `UNSUPPORTED_MEDIA_TYPE`.                                                                                                                                                                                                                  |
| `400`  | `MALFORMED_JSON` / `INVALID_PAYLOAD`. The message includes the Zod issues.                                                                                                                                                                 |
| `413`  | Body over the limit (Fastify's default error body).                                                                                                                                                                                        |
| `422`  | `NOT_ELIGIBLE`: the offer isn't `SIGNED` or the candidate isn't `CLEARED`. Only a signed offer for a cleared candidate may start onboarding. Nothing is persisted.                                                                         |
| `409`  | `EVENT_ID_CONFLICT`: this `eventId` was already accepted with different content. Nothing is written.                                                                                                                                       |
| `500`  | `INTERNAL_ERROR`: the transaction rolled back. The HRIS should retry.                                                                                                                                                                      |

**The intake transaction:** `createHrisIntakeService(db).acceptOfferSigned(event)` in `@aoo/orchestrator`. It runs in one PostgreSQL transaction:

1. Takes `pg_advisory_xact_lock` on `hris:<eventId>`, so concurrent deliveries of the same event serialize.
2. If a receipt for `eventId` exists, returns it as a duplicate when `payload_sha256` matches, or raises a conflict when it doesn't. The hash is taken over the Zod-parsed event, so a re-serialized retry (different key order or whitespace) still matches.
3. Upserts the employee by `employeeId`. This also row-locks the employee, so different events for the same hire serialize.
4. Reuses the employee's **active** (non-terminal) workflow if there is one, recording audit event `hris.offer_signed.linked`. Otherwise it creates a new workflow in `RECEIVED` (audit `workflow.created`, actor `hris-webhook`). A hire whose previous workflow is `COMPLETED` or `FAILED` gets a new workflow.
5. Inserts the receipt, whose `event_id` is unique.
6. Inserts one outbox event: `hris.offer_signed.accepted`, aggregate `onboarding_workflow/<workflowId>`, idempotency key `hris.offer_signed.accepted:<eventId>`, payload `HrisOfferSignedAcceptedPayloadSchema` = `{ workflowId, workflowCreated, receiptId, hrisEventId, hrisEventType, hrisEmployeeId }`.

The correlation ID for every row is `hris:<eventId>`. Any failure rolls back all six steps, the API returns 500, and a retry with the same event then succeeds.

**HRIS simulator:** `apps/hris-simulator` signs synthetic events with the same protocol and POSTs them.

```sh
export HRIS_WEBHOOK_SECRET=dev-only-hris-webhook-secret-change-me   # compose default
pnpm hris:simulate                               # one eligible event (expect 202)
pnpm hris:simulate --count 5                     # five hires
pnpm hris:simulate --save evt.json               # send and save the event...
pnpm hris:simulate --from-file evt.json --repeat 5   # ...then redeliver it 5x concurrently (duplicates)
pnpm hris:simulate --candidate-status PENDING    # expect 422
pnpm hris:simulate --bad-signature               # expect 401
pnpm hris:simulate --help
```

Each run generates fresh random fields. Reusing `--event-id` from an earlier run therefore sends different content and returns 409, by design. Use `--from-file` to resend an event exactly. The simulator exits non-zero if any delivery is not 202.

### Outbox worker (in place since M3B)

`apps/worker` is a separate process from the API that consumes `outbox_events`. The logic lives in `@aoo/orchestrator` and is split into two layers:

- **Transport-independent handlers** (`src/events/`): `EventEnvelope → HandlerResult` (`processed` or `skipped`). Handlers never see leases or SQL. Throwing `PermanentEventError` means dead-letter now; any other error is retried. The registry is `createEventHandlers({ workflows })`. The future SQS transport reuses these handlers unchanged.
- **Transport** (`src/outbox/`): the `OutboxStore` interface (`claim`, `complete`, `fail`), `createPostgresOutboxStore(db)`, and `createOutboxRunner(store, options)`. The runner applies the retry policy and backoff, and runs one batch's handlers concurrently. An SQS transport would implement `OutboxStore` (receive, delete, change visibility).

**Claiming and leases:**

- `claim` runs `SELECT … WHERE status='PENDING' AND available_at <= now AND (no lease OR lease expired) … FOR UPDATE SKIP LOCKED LIMIT batch`. It then sets a fresh `lease_token` (UUID), `lease_owner` and `lease_expires_at = now + OUTBOX_LEASE_MS`, increments `attempts` and `cycle_attempts`, and inserts an `outbox_event_attempts` row, all in one transaction. Any attempt row still open for the event is closed as `LEASE_EXPIRED`. At most one valid lease per event can exist.
- **Fencing:** `complete` and `fail` update only `WHERE id AND lease_token = <mine> AND status='PENDING' AND lease_expires_at > clock_timestamp()`. If zero rows match, the store raises `LeaseLostError` and the runner discards its result. A stale worker can never acknowledge, fail or overwrite an event after its lease expired or was taken over.
- **Crash recovery:** a worker that dies leaves an expired lease behind. Any worker reclaims the event after `OUTBOX_LEASE_MS`.

**Retries:**

- Delay before retry _n_ = `min(OUTBOX_BACKOFF_MAX_MS, OUTBOX_BACKOFF_BASE_MS · 2^(n-1))`, with equal jitter: uniformly distributed between half that value and the full value. It is applied as `available_at = now + delay`.
- After `OUTBOX_MAX_ATTEMPTS` claims in a cycle, a permanent error or an unknown event type, the event becomes `DEAD_LETTERED` (sets `dead_lettered_at`). `last_error` holds the latest error, and every attempt keeps its error and details. Errors are stored with their `cause` chain and codes (`detail.error.cause`), and `last_error` appends the root cause, for example `Error: Failed query … [root cause: error (P0001): …]`. Without this, Drizzle's `Failed query` wrapper hides the PostgreSQL error.

**Redrive:**

- `pnpm worker:admin dead-letters` lists dead letters.
- `pnpm worker:admin redrive --id <uuid> [--id …] --reason "<why>" [--actor <who>] [--dry-run]` redrives them. It only updates rows that are currently `DEAD_LETTERED`: status becomes `PENDING`, `cycle_attempts` resets to 0, `available_at` becomes now and `redrive_count` is incremented. Attempt history and `attempts` are kept. Each redrive writes an `outbox.event.redriven` audit event. Redriving concurrently or twice is safe.

**`hris.offer_signed.accepted` handler:**

- `workflowCreated: false` (the event was linked to an already active workflow): skipped with `ACTIVE_WORKFLOW_REUSED`. The workflow is never read, restarted or re-run.
- `workflowCreated: true`: calls `WorkflowService.transition(RECEIVED → ACCESS_PLANNING)` with the current version and `idempotencyKey = workflow-start:<workflowId>`. A retry after a crash that happened after the commit but before the ack replays as a no-op, with no duplicate steps or audit events.
- If the workflow already left `RECEIVED` without our start, for example because it was failed manually, the event is skipped with `WORKFLOW_NOT_IN_RECEIVED`.
- A version conflict is retried. A malformed payload or missing workflow is a permanent error.

**Process behavior:**

- **Poll loop:** a full batch polls again immediately; otherwise it waits `OUTBOX_POLL_INTERVAL_MS`. After infrastructure errors the wait backs off, up to 30 s.
- **SIGTERM/SIGINT:** stops claiming, finishes the in-flight batch (up to `WORKER_SHUTDOWN_TIMEOUT_MS`), closes the pool and exits 0. On a hard kill, the leases expire and another worker recovers the events.
- **Health** on `WORKER_HEALTH_PORT`:
  - `GET /live` returns 200 while the loop keeps turning.
  - `GET /ready` returns 200 when the last poll reached PostgreSQL and the worker isn't stopping, and 503 otherwise.
  - Both return JSON: `workerId`, `lastPollAt`, `lastPollError`, `consecutiveFailures`, totals and uptime.
- **Logs:** pino JSON on stdout, with `service`, `workerId`, `eventId`, `eventType`, `attempt`, `cycleAttempt` and `correlationId`.
- **Handlers must be idempotent.** Delivery is at-least-once, and a handler can outlive its lease.

### Integrations

These are real systems. **Don't fake the final integrations.** Unit tests may use test doubles. Each integration milestone must also include tests that run against that system's real sandbox (the ServiceNow PDI, the Okta developer org, or a GitHub test org). The adapters that ship must call the real APIs.

| System             | Purpose                                |
| ------------------ | -------------------------------------- |
| ServiceNow PDI     | Access tickets and human approvals     |
| Okta developer org | Identity and group provisioning        |
| GitHub API         | Engineering access (org, teams, repos) |

Credentials come from environment variables through the Zod config loader. Never commit them.

### ServiceNow adapter (in place since M4A: read-only)

`@aoo/servicenow` is a Table REST API client for the ServiceNow PDI. It doesn't depend on the workflow engine: its only dependency is `zod`, and it has no `@aoo/*` imports.

**PDI and application:** the one-time manual setup is in `packages/servicenow/servicenow-app/SETUP.md`:

- the PDI;
- the scoped application **Autonomous Onboarding**;
- the table;
- a read role and ACL;
- a web-service-only integration user.

**Authoritative ServiceNow configuration:** `packages/servicenow/servicenow-app/update-sets/autonomous-onboarding-1.0.0.xml`. This is the published update set for the scoped application `x_2230066_autono_0` (Autonomous Onboarding, version 1.0.0), with 39 records:

- the application metadata;
- the table, extending Task;
- 8 dictionary entries and field labels;
- the `policy_decision` choice list;
- the `OAR` number counter;
- the roles `integration_reader`, `user` and `admin`;
- 3 read ACLs, all requiring `integration_reader`;
- the form layout.

It was reviewed before being added and contains **no** users, role assignments, passwords, tokens, key material, email addresses or data records. To re-create the app on another instance, use **Retrieved Update Sets → Import Update Set from XML**, then preview and commit. The Fluent (code) table file from the Build Agent is optional and was not exported.

**Table:** `<scope>_onboarding_access_request`, labelled **Onboarding Access Request**, which **extends `task`**. Its columns (scoped, no `u_` prefix) are defined in `src/table-spec.ts`, the single source of truth:

| Column                  | Type         | Notes                                                                 |
| ----------------------- | ------------ | --------------------------------------------------------------------- |
| `employee_id`           | String(100)  | Mandatory                                                             |
| `workflow_id`           | String(40)   | Mandatory                                                             |
| `resource_id`           | String(255)  | Mandatory                                                             |
| `requested_entitlement` | String(255)  | Mandatory                                                             |
| `agent_reason`          | String(4000) |                                                                       |
| `policy_decision`       | Choice(40)   | `pending` / `allow` / `deny` / `requires_approval`; default `pending` |
| `correlation_key`       | String(255)  | Mandatory, **unique** (the external correlation key)                  |

`number`, `state`, `short_description` and similar fields are inherited from Task.

**Authentication:**

- HTTP Basic over HTTPS, as a dedicated, least-privilege integration user with _web service access only_ and read access to the one table.
- Credentials come only from `SERVICENOW_*` environment variables, loaded from the git-ignored `.env`.
- OAuth may replace Basic when write access arrives; that's a later decision.

**Client** (`createServiceNowClient(config, { fetch?, logger?, sleep? })`):

- `verifyConnectivity()` authenticates and reads one row of the table.
- `queryAccessRequests({ employeeId?, workflowId?, correlationKey?, limit?, offset? })` returns validated records. The encoded query rejects values containing `^` or line breaks, which blocks query injection.
- `getAccessRequest(sysId)` returns the record, or `null` on 404.
- `describeAccessRequestTable()` reads `sys_db_object` and `sys_dictionary`, and `checkAccessRequestTable()` compares the result with the spec.
- **GET only.** There is no POST, PATCH or DELETE anywhere.

**Resilience:**

- Each attempt has its own timeout (`AbortSignal.timeout`).
- Network errors, timeouts, 429 and 5xx get bounded retries (`SERVICENOW_MAX_RETRIES`) with jittered exponential backoff; `Retry-After` is honored, capped at 10 s.
- 401 and 403 are never retried.
- Redirects are not followed.

**Error types** (`ServiceNowError` subclasses, each with `code`, `operation`, `status` and `retryable`):

| Code                                                                                         | Error class                  | Cause                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `CONFIG_INVALID`                                                                             | `ServiceNowConfigError`      | Bad configuration                                           |
| `REQUEST_INVALID`                                                                            | `ServiceNowRequestError`     | Input rejected before sending                               |
| `AUTHENTICATION_FAILED`                                                                      | `ServiceNowAuthError`        | 401                                                         |
| `PERMISSION_DENIED`                                                                          | `ServiceNowPermissionError`  | 403                                                         |
| `TIMEOUT`                                                                                    | `ServiceNowTimeoutError`     | Every attempt timed out                                     |
| `UNAVAILABLE`                                                                                | `ServiceNowUnavailableError` | Network failure, 429 or 5xx                                 |
| `INSTANCE_UNAVAILABLE`                                                                       | `ServiceNowUnavailableError` | Redirect or HTML page, e.g. a hibernating PDI               |
| `BAD_REQUEST` / `NOT_FOUND` / `MALFORMED_RESPONSE` / `SCHEMA_MISMATCH` / `UNEXPECTED_STATUS` | `ServiceNowResponseError`    | 400, 404, unparseable body, schema mismatch, other statuses |

**Redaction:**

- Logs contain only operation, method, origin and path, status, attempt and duration. They never include headers, query strings (which can hold employee data) or bodies.
- Error messages are built from safe parts and passed through `redactText()`, which masks `Basic`/`Bearer` tokens, URL userinfo and secret-like `key=value` pairs.
- `redact()` masks sensitive keys at any depth.
- Configuration errors name the variable but never echo its value.

**Live test** (explicit only): `pnpm test:servicenow:live` runs `packages/servicenow/test/live/` with `vitest.live.config.ts`, loading `.env`. It is **never** part of `pnpm test` or `pnpm test:integration`. It checks, using GET requests only:

- authentication;
- a query of the custom table;
- a by-`sys_id` read, and `null` for an unknown `sys_id`;
- that the table extends Task with all spec columns (using the optional `SERVICENOW_SCHEMA_*` admin credentials);
- that a wrong password gives `ServiceNowAuthError`.

Without configuration it **fails** with `BLOCKED: …`. It never skips or passes silently.

`pnpm servicenow:check [--schema]` prints the same checks as redacted JSON.

**Schema-verification credentials are isolated:**

- `SERVICENOW_SCHEMA_USERNAME` and `SERVICENOW_SCHEMA_PASSWORD` are read only by `src/schema-verification.ts` (`loadSchemaVerificationConfig`). That module is imported only by `src/bin/check.ts --schema` and the live test, and is **not exported** from `@aoo/servicenow`.
- `loadServiceNowConfig()`, the runtime path, ignores `SERVICENOW_SCHEMA_*`.
- Neither loader falls back to the other's credentials. Unit tests enforce all of this.
- The account is a dedicated `aoo.schema.verifier` user with the `admin` role. On this PDI, the built-in `admin` account was rejected for Basic-auth API calls.

**Choices query:** `sys_choice` is queried by table name, and inactive rows are filtered in code. An encoded `inactive=false` condition matched no rows on the real PDI.

**Passwords in `.env` must be single-quoted.** Generated ServiceNow passwords contain `#` and `$`; an unquoted `#` truncated a 100-character password to 62 characters, causing 401s. A unit test also guards that `.env.example` never contains a ServiceNow password.

#### M4A verification record

Verified on PDI `https://dev225201.service-now.com`, 2026-09-24, with one synthetic record (`OAR0001002`: employee `TEST-EMP-0001`, correlation key `m4a-synthetic-0001`; no real employee data):

- **Least-privilege access:** `aoo.integration` (role `x_2230066_autono_0.integration_reader` only) authenticates, queries the table, lists the synthetic record (also filtered by correlation key), and retrieves it by `sys_id`. The record validates against `AccessRequestRecordSchema`.
- **Schema check** (`pnpm servicenow:check --schema`, as `aoo.schema.verifier`): the table extends `task` in scope `x_2230066_autono_0`, all 7 columns match the spec, `correlation_key` is unique, and `policy_decision` has exactly `pending`, `allow`, `deny` and `requires_approval`, with default `pending`. No problems.
- **Wrong credentials** are rejected with `ServiceNowAuthError` (401).
- **Test counts:**
  - `pnpm check`: 204 unit tests, 47 of them ServiceNow;
  - `pnpm test:integration`: 58;
  - `pnpm test:servicenow:live`: 5 / 5;
  - `pnpm build`: all 9 packages.
- **No secrets exposed:** none in logs, errors or test output. None of the 160 committable files contains either real password.

**Remaining limitations (accepted for M4A):**

- **Read-only:** the adapter doesn't create tickets, write or approve; that's M4B+. Nothing in the workflow calls it yet.
- **Authentication:** Basic auth. OAuth is a later decision.
- **Instance lifecycle:** the PDI hibernates when idle (reported as `INSTANCE_UNAVAILABLE`) and can be reclaimed. The update-set XML is the recovery path.
- **Accounts on the PDI:**
  - `aoo.schema.verifier` holds `admin`. Its password lives only in the local `.env`.
  - `aoo.integration` has **not** been set to _web service access only_: the field isn't on this release's default user form. Add it through **Configure → Form Layout** and check it to block interactive login. Its identity type is still Human.
- **Duplicate ACL:** there are two identical table-level read ACLs, which is harmless.
- **Synthetic record:** `OAR0001002` stays in the PDI as a live-test fixture.

### Workflow trigger and scope

- **Trigger:** an HRIS event confirming that the employee has signed an offer and is cleared. The workflow starts only from this event.
- **Out of scope:** document parsing, credential verification, registry lookups and background checks. Don't build them or stub them. The HRIS event is taken as proof that these checks are already done.

### Platform guarantees

These are what the finished platform must provide. Build each one in the milestone that needs it.

- **Durable state:** workflows and steps are persisted and can be resumed.
- **Authenticated webhooks:** every inbound webhook (HRIS, ServiceNow, Okta, GitHub) is verified, by signature or shared secret, before it is processed. Unverified requests are rejected.
- **Idempotent execution:** every external write carries a **durable idempotency key**, persisted before the call is made. Replays and duplicate deliveries never repeat side effects. Where a provider has no native idempotency, the adapter reads back the provider's state after the write, and reconciliation catches whatever read-back misses.
- **Correlation IDs:** every external operation, read or write, carries a correlation ID. It is propagated to logs, audit entries and traces.
- **External-state reconciliation:** the platform periodically compares expected state with the actual state in ServiceNow, Okta and GitHub, then repairs or flags drift.
- **Retries:** failures are retried with bounded backoff. After the retries run out, the failure lands in a visible failed state, never a silent drop.
- **Audit logging:** an append-only record of every recommendation, policy decision, approval and external action. Each entry records the actor, the inputs and the outcome.
- **OpenTelemetry:** traces and metrics across the API, workflow steps, worker and adapters.

### Layout

In place:

```
apps/
  api/        @aoo/api     Fastify server. src/app.ts = buildApp() factory, src/server.ts = process entry
  web/        @aoo/web     Next.js App Router. app/ = routes, app/api/* = route handlers
  hris-simulator/ @aoo/hris-simulator  CLI that signs and sends synthetic HRIS events (pnpm hris:simulate)
  worker/      @aoo/worker        Outbox worker process (poll loop, /live, /ready, pino logs) + admin CLI (pnpm worker:admin)
packages/
  shared/        @aoo/shared        Zod schemas + inferred types (incl. WORKFLOW_STATES). Built to dist/ with tsc
  db/            @aoo/db            Drizzle schema, pg client, config loader, migrator. migrations/ = versioned SQL
  orchestrator/  @aoo/orchestrator  Workflow state machine + WorkflowService (owns workflow persistence)
  webhooks/      @aoo/webhooks      Webhook signature protocols (HRIS HMAC-SHA256). Node-only
  servicenow/    @aoo/servicenow    ServiceNow Table API client (read-only, M4A); servicenow-app/ = PDI setup guide + update-set exports
```

Location decisions made in M2: the database schema, client and migrations live in `@aoo/db`. The orchestrator lives in `@aoo/orchestrator`, which depends on `@aoo/db` and `@aoo/shared`.

Location decisions made in M3A:

- The HRIS intake transaction lives in `@aoo/orchestrator` (`hris-intake.ts`), because it writes workflow tables.
- The receipt and outbox tables are in `@aoo/db`.
- The signature protocol is in `@aoo/webhooks`, so the API and the simulator share it without importing each other.
- The simulator is an app (`apps/hris-simulator`).

Location decisions made in M3B:

- Event handlers (`src/events/`) and the outbox transport, store and runner (`src/outbox/`) live in `@aoo/orchestrator`, because they write workflow and outbox tables.
- `apps/worker` is only the process shell: config, loop, health, logging and the admin CLI.

Location decisions made in M4A:

- The ServiceNow adapter is its own package, `@aoo/servicenow`, depending only on `zod`.
- The PDI setup guide and update-set exports live in `packages/servicenow/servicenow-app/`.

Not yet created: the resource catalog, company onboarding rules, the outbox worker, the policy engine, the agents and the adapters. **Package locations for these stay flexible.** The milestone that introduces each one decides where it lives, following the dependency rules below, and records the decision in this file.

### Dependency rules

- `apps/*` may depend on `packages/*`. `packages/*` never depend on `apps/*`.
- Apps never import from each other. Web talks to the API over HTTP only (`API_BASE_URL`).
- `@aoo/shared` has no runtime dependencies other than `zod`. No Node-only or browser-only APIs in it.
- The web app talks only to backend APIs. It never accesses the database or enterprise integrations (ServiceNow, Okta, GitHub) directly.
- Agent code can't depend on provisioning adapters or write to the database directly.
- Only the orchestrator writes workflow state and invokes adapters. In code: only `@aoo/orchestrator` writes the workflow tables (`onboarding_workflows`, `workflow_steps`, `audit_events`). Other packages that depend on `@aoo/db` must not write them.
- `@aoo/db` depends only on `@aoo/shared`, `drizzle-orm`, `pg` and `zod`. It contains schema and plumbing, not domain logic.
- In code, only `@aoo/orchestrator` writes `hris_event_receipts` and `outbox_events`. The API calls orchestrator services. It uses `@aoo/db` only to create the connection and must not write tables itself.
- `@aoo/webhooks` has no workspace dependencies. It may use Node APIs (`node:crypto`), so it must not be imported by `@aoo/shared` or the web app.
- In code, only `@aoo/orchestrator` writes `outbox_event_attempts` and outbox status and lease columns. `apps/worker` uses `@aoo/db` only to create the connection.
- Event handlers depend on services (`WorkflowService`), never on the outbox store or transport types.
- `@aoo/servicenow` (and future Okta and GitHub adapters) must not import `@aoo/orchestrator`, `@aoo/db` or any workflow code. Only `@aoo/orchestrator` may call adapters, and nothing calls `@aoo/servicenow` yet.

### Service endpoints

| Service | Port | Health            | Response schema        |
| ------- | ---- | ----------------- | ---------------------- |
| api     | 4000 | `GET /health`     | `HealthResponseSchema` |
| web     | 3000 | `GET /api/health` | `HealthResponseSchema` |

| Compose service | Role                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`      | PostgreSQL 18, host port `${POSTGRES_PORT:-5432}`. Data persists in the named volume `pgdata`; `docker compose down -v` deletes it. Healthcheck: `pg_isready`. |
| `migrate`       | One-shot job (`--target migrate`) that applies migrations once `postgres` is healthy, then exits 0.                                                            |

Docker `HEALTHCHECK`s poll the HTTP endpoints. Compose starts `api` only after `postgres` is healthy **and** `migrate` has exited successfully, and starts `web` only after `api` is healthy. `/health` is liveness only; it doesn't check the database. The `worker` service (M3B) starts after `postgres` is healthy and `migrate` has succeeded. It publishes no port, so `docker compose up --scale worker=N` works; its Docker healthcheck polls `/ready` inside the container. It has a 20 s stop grace period for graceful shutdown. The HRIS simulator isn't in Compose; run it from the host.

### Environment variables

All env vars are read through Zod loaders. `.env.example` lists every variable.

| Variable                                                                      | Used by                                                                                               | Default                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `API_HOST`, `API_PORT`, `LOG_LEVEL`                                           | api                                                                                                   | `0.0.0.0`, `4000`, `info`                                                                                          |
| `WEB_PORT` / `PORT`                                                           | web (dev / container)                                                                                 | `3000`                                                                                                             |
| `API_BASE_URL`                                                                | web                                                                                                   | `http://localhost:4000`                                                                                            |
| `DATABASE_URL`                                                                | `@aoo/db` (`pnpm db:migrate`, the `migrate` container), api (required since M3A)                      | required, `postgres://` URL                                                                                        |
| `HRIS_WEBHOOK_SECRET`                                                         | api (verifies), hris-simulator (signs)                                                                | required, at least 32 characters. Compose default `dev-only-hris-webhook-secret-change-me` is for development only |
| `HRIS_WEBHOOK_BODY_LIMIT_BYTES`                                               | api                                                                                                   | `65536`                                                                                                            |
| `HRIS_WEBHOOK_URL`                                                            | hris-simulator                                                                                        | `http://localhost:4000/webhooks/hris`                                                                              |
| `WORKER_ID`                                                                   | worker                                                                                                | `<hostname>-<pid>` (unique per container replica)                                                                  |
| `WORKER_HEALTH_HOST`, `WORKER_HEALTH_PORT`                                    | worker                                                                                                | `0.0.0.0`, `4100`                                                                                                  |
| `WORKER_SHUTDOWN_TIMEOUT_MS`                                                  | worker                                                                                                | `15000`                                                                                                            |
| `OUTBOX_BATCH_SIZE`                                                           | worker (1–100)                                                                                        | `10`                                                                                                               |
| `OUTBOX_POLL_INTERVAL_MS`                                                     | worker (≥ 10)                                                                                         | `1000`                                                                                                             |
| `OUTBOX_LEASE_MS`                                                             | worker; must exceed the poll interval, and should exceed the worst-case handler time                  | `30000`                                                                                                            |
| `OUTBOX_MAX_ATTEMPTS`                                                         | worker (claims per cycle before dead-lettering)                                                       | `5`                                                                                                                |
| `OUTBOX_BACKOFF_BASE_MS`, `OUTBOX_BACKOFF_MAX_MS`                             | worker; max must be ≥ base                                                                            | `1000`, `300000`                                                                                                   |
| `SERVICENOW_INSTANCE_URL`                                                     | servicenow adapter                                                                                    | required; `https://` origin only, e.g. `https://dev123456.service-now.com`                                         |
| `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`                                  | servicenow adapter                                                                                    | required; integration user (web-service-only, read role). Only in `.env` or a secret store                         |
| `SERVICENOW_ACCESS_REQUEST_TABLE`                                             | servicenow adapter                                                                                    | required; scoped table name, e.g. `x_1234567_autonomo_onboarding_access_request`                                   |
| `SERVICENOW_TIMEOUT_MS`, `SERVICENOW_MAX_RETRIES`, `SERVICENOW_RETRY_BASE_MS` | servicenow adapter                                                                                    | `10000`, `2`, `250`                                                                                                |
| `SERVICENOW_SCHEMA_USERNAME`, `SERVICENOW_SCHEMA_PASSWORD`                    | schema verification only (`pnpm servicenow:check --schema`, live test); never loaded at runtime       | optional; a dedicated verifier account, e.g. `aoo.schema.verifier`                                                 |
| `TEST_DATABASE_URL`                                                           | integration tests: admin connection used to create and drop a throwaway `aoo_test_*` database per run | `postgres://aoo:aoo@localhost:5432/aoo`                                                                            |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`          | compose `postgres` / `migrate`                                                                        | `aoo`, `aoo`, `aoo`, `5432` (development-only credentials)                                                         |

## Coding conventions

- **Validate at boundaries with Zod.** Parse env vars, request bodies, responses, webhook payloads, agent output and external API data with a schema. Define schemas in `@aoo/shared` when more than one app uses them; otherwise keep them local. Derive types with `z.infer`. Don't hand-write duplicate interfaces.
- **Config:** read env only through a Zod-parsed loader (see `apps/api/src/config.ts`). Never read `process.env` anywhere else.
- **Fastify:** build the app in a `buildApp(config)` factory, with no `listen` call, so tests can `app.inject()`. Put each route group in its own plugin under `src/routes/`.
- **Imports:** in `api` and `shared`, relative imports use `.js` extensions (NodeNext). Web uses bundler resolution and the `@/` alias. Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **Naming:** files are `kebab-case.ts`. Zod schemas are `PascalCaseSchema` with a matching `type PascalCase`. Workspace packages use the `@aoo/` scope.
- **Formatting:** Prettier, 100-column width (`pnpm format`). Don't hand-format.
- **Tests:** put them in each package's `test/` directory as `*.test.ts(x)`. Test the API through `app.inject()` and web route handlers by calling them directly. Tests resolve workspace packages to their `src/` through the shared alias list in `vitest.aliases.ts` (repo root), so they don't need a build. Add new workspace packages there.
- **API dependencies:** `buildApp(config, overrides?)` wires real, database-backed services by default. Unit tests may override them with test doubles (for example, `hrisIntake`). The pg pool connects lazily, so building the app never touches the database.
- **Event handlers:** keep them transport-independent (`EventEnvelope` in, `HandlerResult` out) and idempotent. Make at-most-once side effects idempotent with keys (for example, `transition({ idempotencyKey })`), not with pre-checks alone. Throw `PermanentEventError` only when retrying can never help.
- **Integration tests:** put them in `test/integration/` and register them in the package's `vitest.integration.config.ts` (in `apps/*` or `packages/*`). `pnpm test` excludes them; run them with `pnpm test:integration`. Each project's global setup calls `createTestDatabase()` from `@aoo/db/testing`, which creates a fresh, migrated database per run and drops it afterwards. Don't mock the database in integration tests. Race tests should be deterministic: hold a transaction open with a test-only trigger (`pg_sleep`) instead of relying on bursts.
- **Live tests** (external systems such as the ServiceNow PDI): put them in `test/live/*.live.test.ts`, with a dedicated `vitest.live.config.ts` and a root `test:<system>:live` script. Exclude them from the package's unit config. They run only when invoked explicitly, must fail with `BLOCKED` when not configured, and must never be replaced by mocks when reporting live results.
- **Workspace package exports:** each package's `exports` has a `source` condition pointing at `src/index.ts`, before `types`/`default` (dist). Typecheck configs (`tsconfig.json`) set `customConditions: ["source"]`, so typechecking doesn't need a build. Build configs (`tsconfig.build.json`) don't. `tsx --conditions=source` runs workspace code from source.
- **Side effects:** all external calls go through adapters and carry a correlation ID. External writes also carry a durable idempotency key. Domain code never calls ServiceNow, Okta or GitHub directly.
- **Dependencies:** add them to the package that uses them, never to the root, except shared dev tooling. pnpm blocks dependency build scripts by default; approve one with `pnpm approve-builds <pkg>`, which records it under `allowBuilds` in `pnpm-workspace.yaml`.
- **Keep it minimal:** no speculative abstractions, and no dependency the current milestone doesn't need.

## Commands

Run all commands from the repo root.

```sh
pnpm install          # install everything
pnpm dev              # build shared, then run shared (tsc -w), api (tsx watch :4000) and web (next dev :3000)
pnpm build            # build all packages in dependency order
pnpm typecheck        # tsc --noEmit in every package
pnpm test             # unit tests (Vitest across all projects; no database needed)
pnpm test:integration # PostgreSQL integration tests: orchestrator + API webhook (needs postgres running, see TEST_DATABASE_URL)
pnpm hris:simulate    # send signed synthetic HRIS events to the API (see HRIS webhook)
pnpm --filter @aoo/worker dev      # run the outbox worker locally (needs DATABASE_URL)
pnpm worker:admin dead-letters     # list dead-lettered outbox events
pnpm worker:admin redrive --id <uuid> --reason "<why>"   # redrive a dead letter (audited)
docker compose up -d --scale worker=2   # full stack with two workers
pnpm servicenow:check [--schema]        # read-only ServiceNow connectivity check (needs SERVICENOW_* in .env)
pnpm test:servicenow:live               # explicit live ServiceNow PDI test (GET only)
pnpm check            # format:check + typecheck + unit tests
pnpm db:generate --name <change>   # generate a SQL migration from schema.ts
pnpm db:migrate                    # apply migrations to DATABASE_URL
docker compose up -d postgres      # start only PostgreSQL (for local dev and integration tests)
docker compose up --build          # full stack; override host ports with API_PORT / WEB_PORT / POSTGRES_PORT
```

`corepack` can't run pnpm 12 on some setups. If `pnpm` isn't on PATH, run `npm i -g pnpm@12.5.1` or use `npx pnpm@12.5.1 <cmd>`.

## Milestone workflow

1. **Start a milestone:** the user states its scope. Restate it, list open questions, and agree on the definition of done before writing code. Work on the branch `m<N>-<short-slug>`.
2. **Stay in scope:** implement only what the milestone asks for. Write anything else you notice under "Follow-ups" in the hand-off instead of building it.
3. **Contracts first:** add or change Zod schemas in `@aoo/shared` before the code that uses them.
4. **Test alongside:** every new endpoint or module gets at least one Vitest test in the same change.
5. **Definition of done:**
   - `pnpm check` passes.
   - `pnpm test:integration` passes against real PostgreSQL.
   - `pnpm build` passes.
   - `docker compose up --build` brings every long-running service to healthy, and one-shot jobs (`migrate`) exit 0.
   - This file is updated: the status table, plus any new architecture or convention.
6. **Hand-off:** summarize what changed, how it was verified, any deviations from this file, and follow-ups. Commit only when the user asks.
