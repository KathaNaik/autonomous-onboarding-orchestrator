import { fileURLToPath } from "node:url";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Resolves workspace packages to their TypeScript sources in tests, so tests never need a build.
 * Mirrors the "source" export condition in each package.json. Subpaths come before bare names.
 */
export const workspaceAliases = [
  { find: /^@aoo\/agents\/testing$/, replacement: src("packages/agents/src/testing.ts") },
  { find: /^@aoo\/agents$/, replacement: src("packages/agents/src/index.ts") },
  { find: /^@aoo\/catalog$/, replacement: src("packages/catalog/src/index.ts") },
  { find: /^@aoo\/db\/testing$/, replacement: src("packages/db/src/testing.ts") },
  { find: /^@aoo\/db$/, replacement: src("packages/db/src/index.ts") },
  { find: /^@aoo\/github$/, replacement: src("packages/github/src/index.ts") },
  { find: /^@aoo\/okta$/, replacement: src("packages/okta/src/index.ts") },
  { find: /^@aoo\/orchestrator$/, replacement: src("packages/orchestrator/src/index.ts") },
  { find: /^@aoo\/policy$/, replacement: src("packages/policy/src/index.ts") },
  { find: /^@aoo\/servicenow$/, replacement: src("packages/servicenow/src/index.ts") },
  { find: /^@aoo\/telemetry\/sdk$/, replacement: src("packages/telemetry/src/sdk.ts") },
  { find: /^@aoo\/telemetry\/testing$/, replacement: src("packages/telemetry/src/testing.ts") },
  { find: /^@aoo\/telemetry$/, replacement: src("packages/telemetry/src/index.ts") },
  { find: /^@aoo\/shared$/, replacement: src("packages/shared/src/index.ts") },
  { find: /^@aoo\/webhooks$/, replacement: src("packages/webhooks/src/index.ts") },
];
