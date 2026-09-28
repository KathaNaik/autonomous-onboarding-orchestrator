// Read-only GitHub preflight: `pnpm github:check`. Makes no writes. Verifies API reachability,
// credentials, the configured organization, read access to organization membership (for the
// fixture account), each configured team target and the fixture account. Prints ids, names and
// booleans only: never the token or headers.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createGitHubClient,
  loadGitHubConfig,
  loadGitHubTargets,
  GITHUB_TEAM_TARGET_ENV,
} from "../index.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  const config = loadGitHubConfig();
  const targets = loadGitHubTargets();
  const client = createGitHubClient(config);
  const report: Record<string, unknown> = { apiUrl: config.apiUrl, credentialsAccepted: false };
  await client.verifyCredentials();
  report.credentialsAccepted = true;
  const orgTarget = targets.get("github-org-membership");
  const org = orgTarget?.org ?? null;
  report.organization = org;
  report.organizationExists = org ? (await client.getOrganization(org)) !== null : false;
  const fixture = process.env.GITHUB_TEST_USERNAME?.trim() || null;
  if (fixture) {
    const user = await client.getUserByLogin(fixture);
    report.fixture = {
      login: fixture,
      exists: user !== null,
      id: user?.id ?? null,
      type: user?.type ?? null,
    };
    if (org && user) {
      // A successful read (active, pending or 404) proves the token can read membership state.
      const m = await client.getOrgMembership(org, fixture);
      report.fixtureOrgMembership = {
        readable: true,
        state: m?.state ?? "none",
        role: m?.role ?? null,
      };
    }
  } else {
    report.fixture = { configured: false, variable: "GITHUB_TEST_USERNAME" };
  }
  const teams = [];
  for (const resourceId of Object.keys(GITHUB_TEAM_TARGET_ENV)) {
    const target = targets.get(resourceId);
    if (!target || target.kind !== "team") {
      teams.push({ resourceId, configured: false });
      continue;
    }
    const team = await client.getTeam(target.org, target.teamSlug);
    const membership =
      team && fixture ? await client.getTeamMembership(target.org, target.teamSlug, fixture) : null;
    teams.push({
      resourceId,
      configured: true,
      slug: target.teamSlug,
      exists: team !== null,
      id: team?.id ?? null,
      name: team?.name ?? null,
      expectedName: target.teamName,
      slugMatches: team ? team.slug === target.teamSlug : null,
      nameMatches: team ? team.name === target.teamName : null,
      fixtureTeamMembership:
        fixture && team
          ? { state: membership?.state ?? "none", role: membership?.role ?? null }
          : null,
    });
  }
  report.teams = teams;
  print(report);
} catch (err) {
  print({
    ok: false,
    error: (err as { toJSON?: () => unknown }).toJSON?.() ?? String((err as Error).message),
  });
  process.exitCode = 1;
}
