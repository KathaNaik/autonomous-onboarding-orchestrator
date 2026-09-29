// M7D runtime ACL verification: `pnpm servicenow:fulfillment:acl-check`. Proves EFFECTIVE
// permissions with the real accounts (not ACL metadata). WRITES ONLY SYNTHETIC RECORDS it creates
// itself (correlation keys "aoo-test-acl-<run>-…"), through the integration account's normal
// create path; it never modifies or deletes pre-existing records. The fulfiller's denied writes
// are verified by authoritative read-back (ServiceNow silently ignores fields a user can't
// write). Prints check names, HTTP status codes and PASS/FAIL only: never credentials or bodies.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createServiceNowClient,
  loadServiceNowConfig,
  type AccessRequestRecord,
  type ServiceNowConfig,
} from "../index.js";
import { loadFulfillerConfig } from "../fulfiller-verification.js";
import { loadSchemaVerificationConfig } from "../schema-verification.js";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const integrationConfig = loadServiceNowConfig();
const fulfillerConfig = loadFulfillerConfig();
const adminConfig = loadSchemaVerificationConfig();
const integration = createServiceNowClient(integrationConfig);
const table = integrationConfig.accessRequestTable;
const run = Date.now().toString(36);
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) =>
  results.push({ check, pass, detail });

/** A raw Table API call as `account` (the adapter itself has no update/delete). Status only. */
async function call(
  account: ServiceNowConfig,
  method: "GET" | "PATCH" | "DELETE" | "POST",
  path: string,
  body?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(new URL(path, account.instanceUrl), {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`,
      Accept: "application/json",
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const recordPath = (sysId: string) => `/api/now/table/${table}/${sysId}`;
const reread = async (sysId: string) => (await integration.getAccessRequest(sysId))!;

async function synthetic(kind: "fulfillment" | "approval"): Promise<AccessRequestRecord> {
  const fields = {
    short_description: `AOO M7D ACL check (${kind}) - synthetic, safe to ignore`,
    employee_id: `TEST-EMP-M7D-ACL-${run}`,
    workflow_id: `00000000-0000-4000-8000-${run.padStart(12, "0").slice(-12)}`,
    resource_id: "aws-dev",
    requested_entitlement: "AWS Development (ACL check)",
    agent_reason: "Synthetic M7D runtime ACL verification record.",
    policy_decision: "allow",
    approval_state: "not_required",
    correlation_key: `aoo-test-acl-${run}-${kind}`,
    ...(kind === "fulfillment" && { request_kind: "fulfillment", fulfillment_state: "pending" }),
    ...(kind === "approval" && { request_kind: "approval" }),
  };
  const res = await call(integrationConfig, "POST", `/api/now/table/${table}`, fields);
  const sysId = (res.json as { result?: { sys_id?: string } } | null)?.result?.sys_id;
  if (res.status !== 201 || !sysId)
    throw new Error(`could not create the synthetic ${kind} record (HTTP ${res.status})`);
  return reread(sysId);
}

try {
  // Synthetic targets only (created now by the integration account's create permission).
  const ful = await synthetic("fulfillment");
  const appr = await synthetic("approval");
  record(
    "integration_writer: creates records (fulfillment/approval)",
    true,
    `${ful.number}, ${appr.number}`,
  );
  // C target: the oldest pre-M7D record (read-only + a no-op write below). ServiceNow backfilled
  // request_kind=approval into pre-M7D rows when the column was added; code still treats an empty
  // kind as an approval record.
  const oldest = await call(
    adminConfig,
    "GET",
    `/api/now/table/${table}?sysparm_query=ORDERBYsys_created_on&sysparm_fields=sys_id,number,sys_updated_on,fulfillment_state&sysparm_limit=1`,
  );
  const historical = (oldest.json as { result: Array<Record<string, string>> }).result[0]!;

  // A. Fulfillment record, as the fulfiller.
  const readF = await call(fulfillerConfig, "GET", recordPath(ful.sysId));
  record("A fulfiller reads a fulfillment record", readF.status === 200, `HTTP ${readF.status}`);
  const upd = await call(fulfillerConfig, "PATCH", recordPath(ful.sysId), {
    fulfillment_state: "in_progress",
  });
  const afterUpd = await reread(ful.sysId);
  record(
    "A fulfiller updates fulfillment_state",
    upd.status === 200 && afterUpd.fulfillmentState === "in_progress",
    `HTTP ${upd.status}, now ${afterUpd.fulfillmentState}`,
  );
  const protectedFields: Record<string, [string, (r: AccessRequestRecord) => string | null]> = {
    request_kind: ["approval", (r) => r.requestKind],
    approval_state: ["approved", (r) => r.approvalState],
    correlation_key: [`aoo-test-acl-${run}-tampered`, (r) => r.correlationKey],
    employee_id: ["TAMPERED", (r) => r.employeeId],
    workflow_id: ["tampered", (r) => r.workflowId],
    resource_id: ["aws-prod", (r) => r.resourceId],
    requested_entitlement: ["tampered", (r) => r.requestedEntitlement],
    policy_decision: ["deny", (r) => r.policyDecision],
    agent_reason: ["tampered", (r) => r.agentReason],
    short_description: ["tampered", (r) => r.shortDescription],
  };
  for (const [field, [value, read]] of Object.entries(protectedFields)) {
    const before = read(afterUpd);
    const res = await call(fulfillerConfig, "PATCH", recordPath(ful.sysId), { [field]: value });
    const after = read(await reread(ful.sysId));
    record(
      `A fulfiller can NOT modify ${field}`,
      after === before,
      `HTTP ${res.status}, unchanged=${after === before}`,
    );
  }
  const del = await call(fulfillerConfig, "DELETE", recordPath(ful.sysId));
  const stillThere = (await integration.getAccessRequest(ful.sysId)) !== null;
  record(
    "A fulfiller can NOT delete",
    stillThere,
    `HTTP ${del.status}, record still exists=${stillThere}`,
  );

  // Work notes: a real journal write, verified by an admin read of sys_journal_field.
  const note = `AOO M7D ACL check ${run}`;
  const wn = await call(fulfillerConfig, "PATCH", recordPath(ful.sysId), { work_notes: note });
  const journal = await call(
    adminConfig,
    "GET",
    `/api/now/table/sys_journal_field?sysparm_query=element_id=${ful.sysId}^element=work_notes&sysparm_fields=value&sysparm_limit=10`,
  );
  const notes = ((journal.json as { result?: Array<{ value?: string }> } | null)?.result ?? []).map(
    (r) => r.value,
  );
  // Optional capability: reported, never a failure (inherited task.work_notes rules may apply).
  const workNotes = notes.includes(note) ? "WORK_NOTES_VERIFIED" : "WORK_NOTES_UNSUPPORTED_M7D";
  record(
    `work_notes (optional): ${workNotes}`,
    true,
    `HTTP ${wn.status}, journal entries=${notes.length}`,
  );

  // B. Approval record and C. no-kind record: no read, no write through the fulfillment role.
  for (const [label, target] of [["B approval", appr]] as const) {
    const r = await call(fulfillerConfig, "GET", recordPath(target.sysId));
    const listed = await call(
      fulfillerConfig,
      "GET",
      `/api/now/table/${table}?sysparm_query=sys_id=${target.sysId}&sysparm_fields=sys_id`,
    );
    const listCount = ((listed.json as { result?: unknown[] } | null)?.result ?? []).length;
    record(
      `${label}: fulfiller can NOT read`,
      r.status !== 200 && listCount === 0,
      `GET HTTP ${r.status}, list rows=${listCount}`,
    );
    const w = await call(fulfillerConfig, "PATCH", recordPath(target.sysId), {
      fulfillment_state: "fulfilled",
    });
    const after = await reread(target.sysId);
    record(
      `${label}: fulfiller can NOT write`,
      after.fulfillmentState === target.fulfillmentState,
      `HTTP ${w.status}, unchanged=${after.fulfillmentState === target.fulfillmentState}`,
    );
  }

  // C. A pre-M7D (historical) record: no read; a NO-OP write (same value) must not touch it.
  {
    const r = await call(fulfillerConfig, "GET", recordPath(historical.sys_id!));
    record(
      "C historical: fulfiller can NOT read",
      r.status !== 200,
      `${historical.number}: GET HTTP ${r.status}`,
    );
    const w = await call(fulfillerConfig, "PATCH", recordPath(historical.sys_id!), {
      fulfillment_state: historical.fulfillment_state ?? "",
    });
    const after = await call(
      adminConfig,
      "GET",
      `/api/now/table/${table}/${historical.sys_id}?sysparm_fields=sys_updated_on`,
    );
    const untouched =
      (after.json as { result: { sys_updated_on: string } }).result.sys_updated_on ===
      historical.sys_updated_on;
    record(
      "C historical: fulfiller can NOT write",
      w.status !== 200 && untouched,
      `PATCH HTTP ${w.status}, untouched=${untouched}`,
    );
  }

  // D. Integration roles: read unchanged; create works (above); NO update rights.
  const readI = await integration.queryAccessRequests({
    correlationKey: ful.correlationKey,
    limit: 2,
  });
  record(
    "D integration_reader still reads (by correlation key)",
    readI.length === 1,
    `rows=${readI.length}`,
  );
  const iw = await call(integrationConfig, "PATCH", recordPath(ful.sysId), {
    fulfillment_state: "fulfilled",
  });
  const afterIw = await reread(ful.sysId);
  record(
    "D integration account can NOT update (create-only)",
    afterIw.fulfillmentState === "in_progress",
    `HTTP ${iw.status}, still ${afterIw.fulfillmentState}`,
  );

  const failed = results.filter((r) => !r.pass);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        syntheticRecords: [ful.number, appr.number],
        workNotes,
        results,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message, results }, null, 2));
  process.exitCode = 1;
}
