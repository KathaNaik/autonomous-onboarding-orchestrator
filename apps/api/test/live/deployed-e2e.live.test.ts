// (M10) Canonical deployed end-to-end: `pnpm test:deployed:e2e`.
//
// Drives the PRODUCTION deployment only through its public HTTPS surface:
//   signed HRIS event → aoo-api.vercel.app → Neon (workflow + outbox)
//   → signed QStash delivery → aoo-worker.vercel.app (real OpenAI Role Access Agent, policy,
//     ServiceNow approval ticket, fulfillment records, GitHub, Okta, MANUAL)
//   → human approver in the ServiceNow PDI → REAL ServiceNow business-rule callback over public
//     HTTPS (no tunnel) → worker read-back → provisioning → real OpenAI onboarding plan → COMPLETED.
// It never calls internal orchestration services. Human steps use the same synthetic accounts as
// the M4C/M7D live tests (approver = schema verifier, fulfiller = least-privilege fulfiller) and
// the production operator API (HR GitHub username, MANUAL completion).
// Synthetic data only. Prints ids, states and counts; never a secret.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hrisSignatureHeaders } from "@aoo/webhooks";
import { WorkflowObservabilityViewSchema, type WorkflowObservabilityView } from "@aoo/shared";
import { describe, expect, it } from "vitest";

const API = "https://aoo-api.vercel.app";
const WORKER_URL = "https://aoo-worker.vercel.app/api/worker/run";
const env = process.env;

function blocked(reason: string): never {
  throw new Error(`DEPLOYED_E2E_BLOCKED: ${reason}`);
}
const need = (name: string) => env[name]?.trim() || blocked(`${name} is not set in .env`);

const operator = () => ({
  authorization: `Bearer ${need("PRODUCTION_ONBOARDING_ADMIN_TOKEN")}`,
  "x-operator-id": "m10-e2e-hr",
});

async function view(workflowId: string): Promise<WorkflowObservabilityView> {
  const res = await fetch(`${API}/admin/onboarding/${workflowId}`, { headers: operator() });
  if (!res.ok) throw new Error(`read model HTTP ${res.status}`);
  return WorkflowObservabilityViewSchema.parse(await res.json());
}

/** One signed QStash delivery to the production worker (the legitimate off-hours trigger). */
let wakes = 0;
async function wake() {
  const base = (env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/+$/, "");
  const res = await fetch(`${base}/v2/publish/${WORKER_URL}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("QSTASH_TOKEN")}`,
      "content-type": "application/json",
      "upstash-retries": "0",
    },
    body: JSON.stringify({ source: "qstash-schedule" }),
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`QStash publish HTTP ${res.status}`);
  wakes += 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wakes the worker and re-reads until `done` holds (or the deadline passes). */
async function until(
  workflowId: string,
  what: string,
  done: (v: WorkflowObservabilityView) => boolean,
  options: {
    timeoutMs?: number;
    wake?: boolean;
    act?: (v: WorkflowObservabilityView) => Promise<void>;
  } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 240_000);
  for (;;) {
    const v = await view(workflowId);
    if (done(v)) return v;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}: state ${v.workflow.state}, resources ${v.resources
          .map((r) => `${r.resourceId}=${r.status}${r.blocker ? `/${r.blocker}` : ""}`)
          .join(", ")}`,
      );
    }
    await options.act?.(v);
    if (options.wake !== false) await wake();
    await sleep(8_000);
  }
}

async function servicenowPatch(
  sysId: string,
  body: Record<string, string>,
  account: "approver" | "fulfiller",
) {
  const [user, pass] =
    account === "approver"
      ? [need("SERVICENOW_SCHEMA_USERNAME"), need("SERVICENOW_SCHEMA_PASSWORD")]
      : [need("SERVICENOW_FULFILLER_USERNAME"), need("SERVICENOW_FULFILLER_PASSWORD")];
  const instance = need("SERVICENOW_INSTANCE_URL").replace(/\/+$/, "");
  const res = await fetch(
    `${instance}/api/now/table/${need("SERVICENOW_ACCESS_REQUEST_TABLE")}/${sysId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
  );
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`${account} update failed with HTTP ${res.status}`);
}

function sendHris(body: string) {
  return fetch(`${API}/webhooks/hris`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...hrisSignatureHeaders(body, need("PRODUCTION_HRIS_WEBHOOK_SECRET")),
    },
    body,
  });
}

function redeploy(projectId: string) {
  const r = spawnSync("vercel", ["deploy", "--prod", "--yes"], {
    cwd: new URL("../../../../", import.meta.url).pathname,
    env: { ...env, VERCEL_ORG_ID: "team_PdlRwuYzvQPYwlODXtB0bJ5t", VERCEL_PROJECT_ID: projectId },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 600_000,
  });
  if (r.status !== 0) throw new Error(`redeploy of ${projectId} failed`);
}

const summarize = (v: WorkflowObservabilityView) => ({
  state: v.workflow.state,
  resources: Object.fromEntries(v.resources.map((r) => [r.resourceId, r.status])),
  operations: v.externalOperations
    .map((o) => `${o.operationType}:${o.status}:${o.attempts}`)
    .sort(),
  approvals: v.approvals.map((a) => `${a.ticketNumber}:${a.status}:cb${a.callbacks.received}`),
  fulfillments: v.fulfillments.map((f) => `${f.ticketNumber}:${f.fulfillmentState}`),
  planId: v.onboardingPlan?.planId ?? null,
  timeline: v.timeline.length,
});

describe("(M10) deployed end-to-end on Vercel + Neon + QStash", () => {
  it("signed HRIS event → real OpenAI + policy → real ServiceNow approval callback → provisioning → real OpenAI plan → COMPLETED; replay is a no-op", async () => {
    for (const name of [
      "PRODUCTION_HRIS_WEBHOOK_SECRET",
      "PRODUCTION_ONBOARDING_ADMIN_TOKEN",
      "QSTASH_TOKEN",
      "SERVICENOW_INSTANCE_URL",
      "SERVICENOW_ACCESS_REQUEST_TABLE",
      "SERVICENOW_SCHEMA_USERNAME",
      "SERVICENOW_SCHEMA_PASSWORD",
      "SERVICENOW_FULFILLER_USERNAME",
      "SERVICENOW_FULFILLER_PASSWORD",
      "GITHUB_TEST_USERNAME",
    ]) {
      need(name);
    }
    const id = randomUUID().slice(0, 8);
    const event = {
      eventId: `m10-e2e-${randomUUID()}`,
      eventType: "offer.signed",
      occurredAt: new Date().toISOString(),
      employeeId: `TEST-EMP-M10-E2E-${id}`,
      employee: {
        firstName: "Deployed",
        lastName: `E2E ${id}`,
        email: `aoo.m10.e2e.${id}@example.com`,
      },
      role: "Site Reliability Engineer (Frontend Platform)",
      department: "Engineering",
      departmentCode: "ENGINEERING",
      roleFamilyCode: "SRE",
      employmentType: "FULL_TIME",
      managerId: "HRIS-MGR-M10",
      offerStatus: "SIGNED",
      candidateStatus: "CLEARED",
      jobDescription:
        "Site reliability engineer for the frontend platform. Owns production operations and " +
        "incident response for the web front end, deploys to the development and production " +
        "AWS accounts, and works daily in the frontend team's GitHub repositories.",
    };
    const body = JSON.stringify(event);

    // 1. Signed HRIS intake through the public API; an immediate replay is a durable duplicate.
    const first = await sendHris(body);
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { workflowId: string; duplicate: boolean };
    const replay = await sendHris(body);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ duplicate: true, workflowId: accepted.workflowId });
    const workflowId = accepted.workflowId;
    console.log(`workflow ${workflowId}`);

    // Off-hours proof: with the business-hours schedule inactive, the committed work waits.
    const phoenix = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Phoenix",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hour = Number(phoenix.find((p) => p.type === "hour")?.value);
    const day = phoenix.find((p) => p.type === "weekday")?.value ?? "";
    if (["Sat", "Sun"].includes(day) || hour < 9 || hour > 16) {
      await sleep(75_000);
      const waiting = await view(workflowId);
      expect(waiting.workflow.state).toBe("RECEIVED");
      console.log("off-hours: workflow waited durably in RECEIVED for 75 s");
    }

    // 2. Worker (signed QStash): start → real OpenAI Role Access Agent → policy authorization.
    let v = await until(workflowId, "authorization", (x) =>
      ["AWAITING_APPROVAL", "PROVISIONING", "ONBOARDING_GENERATION", "COMPLETED"].includes(
        x.workflow.state,
      ),
    );
    console.log("authorized", JSON.stringify(summarize(v)));
    expect(v.roleAccessRun).toMatchObject({ status: "SUCCEEDED" });
    expect(v.roleAccessRun?.servedModel).toBeTruthy();
    expect(v.policyDecisions.length).toBeGreaterThan(0);

    // 3. Durability across a redeploy while the workflow waits on humans.
    if (env.E2E_REDEPLOY === "1") {
      redeploy("prj_It6P9Qc6r9cP3FLbw5HM77hLLMVg");
      redeploy("prj_CpuveBCelwPxmO96C5lmraw9CN0u");
      console.log("redeployed worker and api mid-flow");
    }

    // 4. Humans: HR records the GitHub username; the approver decides in ServiceNow (the PDI's
    //    business rule then calls the production API over HTTPS); the fulfiller fulfills;
    //    an operator confirms MANUAL resources.
    const login = need("GITHUB_TEST_USERNAME");
    const approved = new Set<string>();
    const fulfilled = new Set<string>();
    const completedManual = new Set<string>();
    let claimRecorded = false;
    v = await until(workflowId, "COMPLETED", (x) => x.workflow.state === "COMPLETED", {
      timeoutMs: 900_000,
      act: async (x) => {
        if (
          !claimRecorded &&
          x.resources.some((r) => r.blocker === "GITHUB_IDENTITY_CLAIM_REQUIRED")
        ) {
          const res = await fetch(`${API}/admin/onboarding/${workflowId}/github-identity`, {
            method: "POST",
            headers: { ...operator(), "content-type": "application/json" },
            body: JSON.stringify({ githubLogin: login }),
          });
          expect(res.status).toBe(200);
          claimRecorded = true;
        }
        for (const a of x.approvals) {
          if (a.status === "PENDING" && a.sysId && !approved.has(a.sysId)) {
            await servicenowPatch(a.sysId, { approval_state: "approved" }, "approver");
            approved.add(a.sysId);
          }
        }
        for (const f of x.fulfillments) {
          if (
            f.sysId &&
            !fulfilled.has(f.sysId) &&
            ["pending", "in_progress"].includes(f.fulfillmentState ?? "")
          ) {
            await servicenowPatch(f.sysId, { fulfillment_state: "fulfilled" }, "fulfiller");
            fulfilled.add(f.sysId);
          }
        }
        for (const r of x.resources) {
          if (r.status === "MANUAL_ACTION_REQUIRED" && !completedManual.has(r.accessRequestId)) {
            const res = await fetch(
              `${API}/admin/access-requests/${r.accessRequestId}/manual-complete`,
              {
                method: "POST",
                headers: { ...operator(), "content-type": "application/json" },
                body: JSON.stringify({ evidence: "License assigned by the M10 E2E operator." }),
              },
            );
            expect(res.status).toBe(200);
            completedManual.add(r.accessRequestId);
          }
        }
      },
    });
    const done = summarize(v);
    console.log("completed", JSON.stringify(done), `wakes ${wakes}`);

    // 5. Outcome: every resource settled; real callbacks arrived; real OpenAI plan accepted.
    expect(v.workflow.state).toBe("COMPLETED");
    expect(v.resources.every((r) => r.settled)).toBe(true);
    expect(v.onboardingPlan?.taskCount).toBeGreaterThanOrEqual(3);
    expect(v.onboardingPlan?.servedModel).toBeTruthy();
    for (const a of v.approvals) {
      expect(a.status).toBe("APPROVED");
      expect(a.callbacks.received).toBeGreaterThanOrEqual(1); // the real ServiceNow callback
    }
    expect(v.externalOperations.every((o) => o.status === "SUCCEEDED")).toBe(true);
    // One ServiceNow ticket per approval and per fulfillment: never duplicated.
    const keys = v.externalOperations.map((o) => o.correlationKey);
    expect(new Set(keys).size).toBe(keys.length);

    // 6. Replay: the same HRIS event again (fresh timestamp) and more scheduler deliveries
    //    change nothing: same plan, same operations and attempts, same timeline.
    const again = await sendHris(body);
    expect(await again.json()).toMatchObject({ duplicate: true, workflowId });
    await wake();
    await sleep(10_000);
    await wake();
    await sleep(10_000);
    expect(summarize(await view(workflowId))).toEqual(done);
  }, 1_800_000);
});
