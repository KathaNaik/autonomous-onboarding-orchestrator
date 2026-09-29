import {
  ServiceNowAuthError,
  ServiceNowOutcomeUnknownError,
  ServiceNowPermissionError,
  ServiceNowResponseError,
  ServiceNowTimeoutError,
  ServiceNowUnavailableError,
  type AccessRequestRecord,
  type CreateAccessRequestInput,
} from "@aoo/servicenow";
import { describe, expect, it } from "vitest";
import {
  formatSanitizedError,
  sanitizeExternalError,
} from "../src/external-operations/sanitize.js";
import { serviceNowAccessRequestKeys } from "../src/external-operations/keys.js";
import {
  BLOCKERS,
  classifyServiceNowFulfillmentError,
  createServiceNowFulfillmentHandler,
  fulfillmentRecordMismatches,
  serviceNowFulfillmentKeys,
  type ServiceNowFulfillmentRequest,
} from "../src/provisioning/index.js";

const ids = {
  accessDecisionId: "0b8c5c6e-2d0a-4a53-9a57-5b0f7f3f6a11",
  accessRequestId: "7f1d8a2b-0c3e-4f5a-8b6c-9d0e1f2a3b4c",
  resourceId: "aws-dev",
};
const keys = serviceNowFulfillmentKeys(ids);
const request: ServiceNowFulfillmentRequest = {
  ...ids,
  workflowId: "1d86449b-9903-465c-9477-e0601907d464",
  employeeId: "HRIS-100",
  requestedEntitlement: "AWS Development",
  policyDecision: "allow",
  agentReason: "Authorized (ENGINEERING_DEVELOPMENT_CLOUD).",
  shortDescription: "AOO fulfillment: AWS Development",
  correlationKey: keys.correlationKey,
};
const record = (over: Partial<AccessRequestRecord> = {}): AccessRequestRecord => ({
  sysId: "a".repeat(32),
  sysClassName: "x_test_onboarding_access_request",
  number: "OAR0002001",
  state: "1",
  shortDescription: request.shortDescription,
  createdOn: "",
  updatedOn: "",
  employeeId: request.employeeId,
  workflowId: request.workflowId,
  resourceId: request.resourceId,
  requestedEntitlement: request.requestedEntitlement,
  agentReason: "",
  policyDecision: "allow",
  approvalState: "not_required",
  correlationKey: request.correlationKey,
  requestKind: "fulfillment",
  fulfillmentState: "pending",
  ...over,
});

describe("fulfillment keys", () => {
  it("are deterministic, query-safe and distinct from the approval ticket's keys", () => {
    expect(serviceNowFulfillmentKeys(ids)).toEqual(keys);
    expect(keys.idempotencyKey).toBe(
      `servicenow.create_fulfillment_request:decision=${ids.accessDecisionId}:request=${ids.accessRequestId}:resource=aws-dev`,
    );
    expect(keys.correlationKey).toMatch(/^aoo-ful-[0-9a-f]{40}$/);
    expect(serviceNowFulfillmentKeys(ids, "aoo-test-ful-").correlationKey).toMatch(
      /^aoo-test-ful-/,
    );
    const approval = serviceNowAccessRequestKeys({
      workflowId: request.workflowId,
      resourceId: "aws-dev",
      requestedEntitlement: "AWS Development",
      accessDecisionId: ids.accessDecisionId,
    });
    expect(approval.idempotencyKey).not.toBe(keys.idempotencyKey);
    expect(approval.correlationKey).not.toBe(keys.correlationKey);
    expect(
      serviceNowFulfillmentKeys({ ...ids, accessRequestId: ids.accessDecisionId }),
    ).not.toEqual(keys);
  });
});

describe("fulfillment handler", () => {
  function gateway(found: AccessRequestRecord[], readBack: AccessRequestRecord | null = null) {
    const creates: CreateAccessRequestInput[] = [];
    const gw = {
      queryAccessRequests: async () => found,
      getAccessRequest: async () => readBack,
      createAccessRequest: async (input: CreateAccessRequestInput) => {
        creates.push(input);
        return record();
      },
    };
    return { handler: createServiceNowFulfillmentHandler(gw), creates };
  }
  const ctx = { signal: new AbortController().signal };

  it("creates exactly one fulfillment record: request_kind=fulfillment, pending, no approval", async () => {
    const { handler, creates } = gateway([]);
    expect(await handler.reconcile(request, ctx)).toEqual({ kind: "absent" });
    await handler.perform(request, ctx);
    expect(creates).toEqual([
      expect.objectContaining({
        requestKind: "fulfillment",
        fulfillmentState: "pending",
        approvalState: "not_required",
        policyDecision: "allow",
        correlationKey: keys.correlationKey,
        resourceId: "aws-dev",
      }),
    ]);
  });

  it("reuses one matching record, stops on duplicates or a mismatched record", async () => {
    expect(await gateway([record()]).handler.reconcile(request, ctx)).toEqual({
      kind: "satisfied",
      externalId: "a".repeat(32),
      externalReference: "OAR0002001",
    });
    expect(
      await gateway([record(), record({ sysId: "b".repeat(32) })]).handler.reconcile(request, ctx),
    ).toMatchObject({
      kind: "conflict",
      code: "DUPLICATE_FULFILLMENT_RECORDS",
    });
    const approvalRecord = record({ requestKind: "approval" });
    expect(await gateway([approvalRecord]).handler.reconcile(request, ctx)).toMatchObject({
      kind: "conflict",
      code: "FULFILLMENT_RECORD_MISMATCH",
      evidence: { mismatchedFields: ["request_kind"] },
    });
    expect(
      await gateway([], record({ resourceId: "aws-prod" })).handler.verify(request, record(), ctx),
    ).toMatchObject({
      kind: "conflict",
      evidence: { mismatchedFields: ["resource_id"] },
    });
  });

  it("reports mismatched field names only (never values)", () => {
    expect(fulfillmentRecordMismatches(record(), request)).toEqual([]);
    expect(
      fulfillmentRecordMismatches(
        record({
          requestKind: null,
          correlationKey: "x",
          workflowId: "y",
          employeeId: "z",
          requestedEntitlement: "w",
        }),
        request,
      ),
    ).toEqual([
      "request_kind",
      "correlation_key",
      "workflow_id",
      "employee_id",
      "requested_entitlement",
    ]);
  });

  it("classifies retries: transient and unknown outcomes retry; auth, permission and bad shapes stop", () => {
    const op = "createAccessRequest";
    expect(classifyServiceNowFulfillmentError(new ServiceNowTimeoutError(op, 5000, 1))).toBe(
      "retry",
    );
    expect(
      classifyServiceNowFulfillmentError(
        new ServiceNowUnavailableError(op, "429", { status: 429, notSent: true }),
      ),
    ).toBe("not_sent");
    expect(
      classifyServiceNowFulfillmentError(
        new ServiceNowUnavailableError(op, "503", { status: 503 }),
      ),
    ).toBe("retry");
    expect(
      classifyServiceNowFulfillmentError(new ServiceNowOutcomeUnknownError(op, "timeout")),
    ).toBe("outcome_unknown");
    expect(classifyServiceNowFulfillmentError(new ServiceNowAuthError(op))).toBe("failed");
    expect(classifyServiceNowFulfillmentError(new ServiceNowPermissionError(op))).toBe("failed");
    expect(
      classifyServiceNowFulfillmentError(new ServiceNowResponseError("SCHEMA_MISMATCH", op, "x")),
    ).toBe("failed");
    expect(
      classifyServiceNowFulfillmentError(new ServiceNowResponseError("BAD_REQUEST", op, "x", 400)),
    ).toBe("failed");
  });
});

describe("fulfillment state mapping blockers", () => {
  it("pending and in-progress are scheduled waits, not failures", () => {
    for (const b of [
      BLOCKERS.SERVICENOW_FULFILLMENT_PENDING,
      BLOCKERS.SERVICENOW_FULFILLMENT_IN_PROGRESS,
    ]) {
      expect(b).toMatchObject({ blockerClass: "WAITING", schedule: "FULFILLMENT" });
    }
  });
});

describe("fulfillment error sanitization", () => {
  it("never stores a password, Basic header, callback secret, tunnel URL or credential payload", () => {
    const password = "Sn0w#Pa$$w0rd-Integration-9f8e7d6c";
    const callbackSecret = "callback-secret-0123456789abcdef0123456789";
    const basic = Buffer.from(`aoo.integration:${password}`).toString("base64");
    const err = new ServiceNowUnavailableError(
      "createAccessRequest",
      `failed: Authorization: Basic ${basic} https://aoo.integration:${password}@dev225201.service-now.com/api?sysparm_query=employee_id=HRIS-100 ` +
        `callback https://quiet-lab-1234.trycloudflare.com/webhooks/servicenow/fulfillment ` +
        `body {"password":"${password}","secret":"${callbackSecret}"} token=${callbackSecret}`,
      { status: 503 },
    );
    const safe = sanitizeExternalError(err, {
      provider: "servicenow",
      sensitiveValues: [password, callbackSecret, "HRIS-100"],
    });
    const text = JSON.stringify(safe) + formatSanitizedError(safe);
    for (const leaked of [
      password,
      basic,
      callbackSecret,
      "trycloudflare.com",
      "quiet-lab-1234",
      "HRIS-100",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(safe).toMatchObject({ provider: "servicenow", httpStatus: 503, retryable: true });
  });
});
