#!/usr/bin/env node
// (M10) Secret-safe Vercel Production environment setup from the local, git-ignored .env.
//
//   node scripts/vercel-env-sync.mjs                    dry run: PRESENT/MISSING per variable
//   node scripts/vercel-env-sync.mjs --apply            core config + core secrets
//   node scripts/vercel-env-sync.mjs --apply --with-providers
//                                                      + provider credentials (enable step)
//   node scripts/vercel-env-sync.mjs --apply --with-providers --enable-features
//                                                      + fulfillment and plan generation on
//   node scripts/vercel-env-sync.mjs --generate-production-secrets
//                                                      append NEW random PRODUCTION_* secrets
//                                                      to .env if absent (never overwrites)
//
// Values travel only through the child process's stdin (`vercel env add NAME production
// --sensitive --force`): never in arguments, output or logs. Output: names, projects, PRESENT /
// MISSING and ADDED / FAILED only. Production environment only (Preview gets nothing).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ORG = "team_PdlRwuYzvQPYwlODXtB0bJ5t";
const PROJECTS = {
  "aoo-web": "prj_w0ZqGVaK1rNNLdCfe4052zQyfpgM",
  "aoo-api": "prj_CpuveBCelwPxmO96C5lmraw9CN0u",
  "aoo-worker": "prj_It6P9Qc6r9cP3FLbw5HM77hLLMVg",
};
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const args = new Set(process.argv.slice(2));

const PRODUCTION_SECRETS = ["PRODUCTION_HRIS_WEBHOOK_SECRET", "PRODUCTION_ONBOARDING_ADMIN_TOKEN"];
if (args.has("--generate-production-secrets")) {
  const env = parseEnv(readFileSync(envPath, "utf8"));
  for (const name of PRODUCTION_SECRETS) {
    if (env[name]) {
      console.log(`${name}: PRESENT (kept)`);
      continue;
    }
    appendFileSync(envPath, `\n${name}='${randomBytes(36).toString("base64url")}'\n`);
    console.log(`${name}: GENERATED (appended to .env)`);
  }
  process.exit(0);
}

const env = parseEnv(readFileSync(envPath, "utf8"));
const fixed = (value) => ({ value, secret: false });
const FEATURES = args.has("--enable-features") ? "true" : "false";
const from = (source, secret, optional = false) => ({ source, secret, optional });

/** project → target name → value spec. `providers` entries apply only with --with-providers. */
const CORE = {
  "aoo-web": {
    AOO_ENVIRONMENT: fixed("production"),
    API_BASE_URL: fixed("https://aoo-api.vercel.app"),
    ONBOARDING_ADMIN_TOKEN: from("PRODUCTION_ONBOARDING_ADMIN_TOKEN", true),
  },
  "aoo-api": {
    AOO_ENVIRONMENT: fixed("production"),
    HRIS_WEBHOOK_SECRET: from("PRODUCTION_HRIS_WEBHOOK_SECRET", true),
    ONBOARDING_ADMIN_TOKEN: from("PRODUCTION_ONBOARDING_ADMIN_TOKEN", true),
    SERVICENOW_CALLBACK_SECRET: from("SERVICENOW_CALLBACK_SECRET", true),
    SERVICENOW_CALLBACK_INSTANCE: from("SERVICENOW_CALLBACK_INSTANCE", false),
    SERVICENOW_CALLBACK_TABLE: from("SERVICENOW_CALLBACK_TABLE", false),
  },
  "aoo-worker": {
    AOO_ENVIRONMENT: fixed("production"),
    WORKER_QSTASH_URL: fixed("https://aoo-worker.vercel.app/api/worker/run"),
    ONBOARDING_PLAN_RUN_LEASE_MS: fixed("60000"),
    ROLE_ACCESS_RUN_LEASE_MS: fixed("60000"),
    OUTBOX_BATCH_SIZE: fixed("5"),
    // Off until the provider preflights pass; --enable-features turns them on (Production only).
    PROVISIONING_SERVICENOW_FULFILLMENT_ENABLED: fixed(FEATURES),
    ONBOARDING_PLAN_GENERATION_ENABLED: fixed(FEATURES),
    ROLE_ACCESS_AGENT_ENABLED: fixed(FEATURES),
    QSTASH_CURRENT_SIGNING_KEY: from("QSTASH_CURRENT_SIGNING_KEY", true),
    QSTASH_NEXT_SIGNING_KEY: from("QSTASH_NEXT_SIGNING_KEY", true),
  },
};
const PROVIDERS = {
  "aoo-api": {
    // M11 offer-letter intake: the flag travels with the key, so the API can never be enabled
    // without it (it would refuse to start); on only with --enable-features.
    OPENAI_API_KEY: from("OPENAI_API_KEY", true),
    OPENAI_MODEL: from("OPENAI_MODEL", false),
    OFFER_LETTER_INTAKE_ENABLED: fixed(FEATURES),
  },
  "aoo-worker": {
    SERVICENOW_INSTANCE_URL: from("SERVICENOW_INSTANCE_URL", false),
    SERVICENOW_ACCESS_REQUEST_TABLE: from("SERVICENOW_ACCESS_REQUEST_TABLE", false),
    SERVICENOW_TIMEOUT_MS: fixed("5000"),
    SERVICENOW_USERNAME: from("SERVICENOW_USERNAME", true),
    SERVICENOW_PASSWORD: from("SERVICENOW_PASSWORD", true),
    GITHUB_TOKEN: from("GITHUB_TOKEN", true),
    GITHUB_ORG: from("GITHUB_ORG", false),
    GITHUB_BACKEND_TEAM_SLUG: from("GITHUB_BACKEND_TEAM_SLUG", false),
    GITHUB_BACKEND_TEAM_NAME: from("GITHUB_BACKEND_TEAM_NAME", false),
    GITHUB_FRONTEND_TEAM_SLUG: from("GITHUB_FRONTEND_TEAM_SLUG", false),
    GITHUB_FRONTEND_TEAM_NAME: from("GITHUB_FRONTEND_TEAM_NAME", false),
    OKTA_BASE_URL: from("OKTA_BASE_URL", false),
    OKTA_API_TOKEN: from("OKTA_API_TOKEN", true),
    OKTA_ENGINEERING_GROUP_ID: from("OKTA_ENGINEERING_GROUP_ID", false),
    OKTA_ENGINEERING_GROUP_NAME: from("OKTA_ENGINEERING_GROUP_NAME", false),
    OKTA_JIRA_ENGINEERING_GROUP_ID: from("OKTA_JIRA_ENGINEERING_GROUP_ID", false, true),
    OKTA_JIRA_ENGINEERING_GROUP_NAME: from("OKTA_JIRA_ENGINEERING_GROUP_NAME", false, true),
    OPENAI_API_KEY: from("OPENAI_API_KEY", true),
    OPENAI_MODEL: from("OPENAI_MODEL", false),
  },
};

const apply = args.has("--apply");
const plan = [CORE, ...(args.has("--with-providers") ? [PROVIDERS] : [])];
let missing = 0;
for (const matrix of plan) {
  for (const [project, vars] of Object.entries(matrix)) {
    for (const [name, spec] of Object.entries(vars)) {
      const value = spec.value ?? env[spec.source]?.trim();
      const label = `${project} ${name}${spec.source && spec.source !== name ? ` (from ${spec.source})` : ""}`;
      if (!value && spec.optional) {
        console.log(`${label}: NOT SET (optional; that resource stays refused)`);
        continue;
      }
      if (!value) {
        missing += 1;
        console.log(`${label}: MISSING`);
        continue;
      }
      if (!apply) {
        console.log(`${label}: PRESENT`);
        continue;
      }
      const result = spawnSync(
        "vercel",
        [
          "env",
          "add",
          name,
          "production",
          spec.secret ? "--sensitive" : "--no-sensitive",
          "--force",
          "--yes",
          "--non-interactive",
        ],
        {
          input: value,
          env: { ...process.env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: PROJECTS[project] },
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      console.log(`${label}: ${result.status === 0 ? "ADDED" : "FAILED"}`);
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}
if (missing > 0) {
  console.log(`${missing} variable(s) MISSING`);
  process.exitCode = 1;
}
