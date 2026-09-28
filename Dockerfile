# syntax=docker/dockerfile:1
# Single multi-target Dockerfile for the monorepo. Build a service with --target api|web|worker|migrate.

FROM node:24-alpine AS base
RUN npm install -g pnpm@12.5.1
WORKDIR /repo

# ---- build: install all deps, compile every workspace package ----
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/hris-simulator/package.json apps/hris-simulator/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/webhooks/package.json packages/webhooks/
COPY packages/servicenow/package.json packages/servicenow/
COPY packages/catalog/package.json packages/catalog/
COPY packages/policy/package.json packages/policy/
COPY packages/agents/package.json packages/agents/
COPY packages/okta/package.json packages/okta/
COPY packages/github/package.json packages/github/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @aoo/api deploy --prod /out/api
RUN pnpm --filter @aoo/db deploy --prod /out/db
RUN pnpm --filter @aoo/worker deploy --prod /out/worker

# ---- api runtime ----
FROM node:24-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api/package.json ./
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT:-4000}/health" >/dev/null || exit 1
CMD ["node", "dist/server.js"]

# ---- worker runtime (outbox consumer; separate process from the API) ----
FROM node:24-alpine AS worker
ENV NODE_ENV=production \
    WORKER_HEALTH_PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out/worker/package.json ./
COPY --from=build --chown=node:node /out/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /out/worker/dist ./dist
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${WORKER_HEALTH_PORT}/ready" >/dev/null || exit 1
CMD ["node", "dist/main.js"]

# ---- web runtime (Next.js standalone output) ----
FROM node:24-alpine AS web
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]

# ---- migrate: one-shot job that applies versioned SQL migrations ----
FROM node:24-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/db/package.json ./
COPY --from=build --chown=node:node /out/db/node_modules ./node_modules
COPY --from=build --chown=node:node /out/db/dist ./dist
COPY --from=build --chown=node:node /out/db/migrations ./migrations
USER node
CMD ["node", "dist/bin/migrate.js"]
