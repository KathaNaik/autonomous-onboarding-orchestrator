# Autonomous Onboarding Orchestrator

This system automates employee onboarding. It starts when an HRIS event confirms that a new hire has signed an offer and been cleared. It then provisions identity, groups and access, including engineering access. Humans approve requests through ServiceNow.

It is a pnpm + TypeScript monorepo, built in milestones (see **Milestone workflow**). Only build what the current milestone asks for.

## Current status

| Milestone | Scope                                                                                                                  | Status              |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------- |
| M1        | Monorepo scaffold: Fastify API, Next.js web, shared Zod schemas, Vitest, Docker Compose, health endpoints, smoke tests | Complete (accepted) |
| M2        | Not yet defined; the user defines it when starting it                                                                  | Not started         |

What exists today is only the M1 scaffold. **No onboarding domain logic, database, workflow engine, agents or integrations exist yet.** Everything under **Confirmed architecture** below is decided but, unless marked "in place", not built. Build each piece only when a milestone asks for it.

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
- **Containers:** one multi-target `Dockerfile` (`--target api|web`) and `docker-compose.yml`.

### Backend shape

- **Modular monolith.** The backend is one deployable made of internal modules with explicit interfaces. There are no microservices. Modules talk to each other through their public interfaces, never through each other's tables or internals.
- **Custom durable workflow orchestrator, written in TypeScript.** Onboarding runs as a workflow. Its state is persisted in PostgreSQL, so a workflow survives restarts and resumes where it stopped. The initial architecture does not use Temporal, Step Functions or Inngest. This is a present choice, not a permanent ban. Adopting one later requires an explicit user decision recorded here.
- **The orchestrator owns persistence and execution.** It is the only component that writes workflow state and the only one that invokes provisioning adapters.

### Database

- **PostgreSQL** is the only system of record.
- **Drizzle ORM** handles queries and schema definitions.
- **Versioned SQL migrations:** generated or written as SQL files, committed to the repo and applied in order. Never change a migration that has already been applied; add a new one instead.
- Workflow state, the outbox, idempotency records and the audit log all live in PostgreSQL.

### Events

- **Transactional outbox.** A state change and the events it emits are written in the same database transaction. A separate dispatcher publishes those events afterwards.
- **Development:** a local worker process polls the outbox and delivers events.
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

### Integrations

These are real systems. **Don't fake the final integrations.** Unit tests may use test doubles. Each integration milestone must also include tests that run against that system's real sandbox (the ServiceNow PDI, the Okta developer org, or a GitHub test org). The adapters that ship must call the real APIs.

| System             | Purpose                                |
| ------------------ | -------------------------------------- |
| ServiceNow PDI     | Access tickets and human approvals     |
| Okta developer org | Identity and group provisioning        |
| GitHub API         | Engineering access (org, teams, repos) |

Credentials come from environment variables through the Zod config loader. Never commit them.

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
packages/
  shared/     @aoo/shared  Zod schemas + inferred types. Built to dist/ with tsc
```

Not yet created: database access and migrations, the resource catalog, company onboarding rules, the orchestrator, the outbox worker, the policy engine, the agents and the adapters. **Package locations for these stay flexible.** The milestone that introduces each one decides where it lives, following the dependency rules below, and records the decision in this file.

### Dependency rules

- `apps/*` may depend on `packages/*`. `packages/*` never depend on `apps/*`.
- Apps never import from each other. Web talks to the API over HTTP only (`API_BASE_URL`).
- `@aoo/shared` has no runtime dependencies other than `zod`. No Node-only or browser-only APIs in it.
- The web app talks only to backend APIs. It never accesses the database or enterprise integrations (ServiceNow, Okta, GitHub) directly.
- Agent code can't depend on provisioning adapters or write to the database directly.
- Only the orchestrator writes workflow state and invokes adapters.

### Service endpoints

| Service | Port | Health            | Response schema        |
| ------- | ---- | ----------------- | ---------------------- |
| api     | 4000 | `GET /health`     | `HealthResponseSchema` |
| web     | 3000 | `GET /api/health` | `HealthResponseSchema` |

Docker `HEALTHCHECK`s poll these endpoints. Compose starts `web` only after `api` is healthy. PostgreSQL and the worker are not in Compose yet. Add them in the milestone that introduces them.

## Coding conventions

- **Validate at boundaries with Zod.** Parse env vars, request bodies, responses, webhook payloads, agent output and external API data with a schema. Define schemas in `@aoo/shared` when more than one app uses them; otherwise keep them local. Derive types with `z.infer`. Don't hand-write duplicate interfaces.
- **Config:** read env only through a Zod-parsed loader (see `apps/api/src/config.ts`). Never read `process.env` anywhere else.
- **Fastify:** build the app in a `buildApp(config)` factory, with no `listen` call, so tests can `app.inject()`. Put each route group in its own plugin under `src/routes/`.
- **Imports:** in `api` and `shared`, relative imports use `.js` extensions (NodeNext). Web uses bundler resolution and the `@/` alias. Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **Naming:** files are `kebab-case.ts`. Zod schemas are `PascalCaseSchema` with a matching `type PascalCase`. Workspace packages use the `@aoo/` scope.
- **Formatting:** Prettier, 100-column width (`pnpm format`). Don't hand-format.
- **Tests:** put them in each package's `test/` directory as `*.test.ts(x)`. Test the API through `app.inject()` and web route handlers by calling them directly. Tests resolve `@aoo/shared` to its `src/`, so they don't need a build.
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
pnpm test             # Vitest across all projects
pnpm check            # format:check + typecheck + test (the gate before finishing any milestone)
docker compose up --build   # full stack in containers; override host ports with API_PORT / WEB_PORT
```

`corepack` can't run pnpm 12 on some setups. If `pnpm` isn't on PATH, run `npm i -g pnpm@12.5.1` or use `npx pnpm@12.5.1 <cmd>`.

## Milestone workflow

1. **Start a milestone:** the user states its scope. Restate it, list open questions, and agree on the definition of done before writing code. Work on the branch `m<N>-<short-slug>`.
2. **Stay in scope:** implement only what the milestone asks for. Write anything else you notice under "Follow-ups" in the hand-off instead of building it.
3. **Contracts first:** add or change Zod schemas in `@aoo/shared` before the code that uses them.
4. **Test alongside:** every new endpoint or module gets at least one Vitest test in the same change.
5. **Definition of done:**
   - `pnpm check` passes.
   - `pnpm build` passes.
   - `docker compose up --build` brings every service to healthy.
   - This file is updated: the status table, plus any new architecture or convention.
6. **Hand-off:** summarize what changed, how it was verified, any deviations from this file, and follow-ups. Commit only when the user asks.
