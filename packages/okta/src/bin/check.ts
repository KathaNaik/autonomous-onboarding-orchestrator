// Read-only Okta preflight: `pnpm okta:check`. Verifies the base URL, the API token and every
// configured group target. Makes no writes. Prints ids, names and booleans only: never the token.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createOktaClient,
  loadOktaConfig,
  loadOktaGroupTargets,
  OKTA_GROUP_TARGET_ENV,
} from "../index.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  const config = loadOktaConfig();
  const targets = loadOktaGroupTargets();
  const client = createOktaClient(config);
  const report: Record<string, unknown> = {
    baseUrl: config.baseUrl,
    credentialsAccepted: false,
    targets: [],
  };
  await client.verifyCredentials();
  report.credentialsAccepted = true;
  const out = [];
  for (const [resourceId, vars] of Object.entries(OKTA_GROUP_TARGET_ENV)) {
    const target = targets.get(resourceId);
    if (!target) {
      out.push({ resourceId, configured: false, idVariable: vars.id });
      continue;
    }
    const group = await client.getGroup(target.groupId);
    out.push({
      resourceId,
      configured: true,
      groupId: target.groupId,
      exists: group !== null,
      type: group?.type ?? null,
      name: group?.profile.name ?? null,
      expectedName: target.expectedName,
      nameMatches:
        target.expectedName === null ? null : group?.profile.name === target.expectedName,
    });
  }
  report.targets = out;
  print(report);
} catch (err) {
  print({
    ok: false,
    error: (err as { toJSON?: () => unknown }).toJSON?.() ?? String((err as Error).message),
  });
  process.exitCode = 1;
}
