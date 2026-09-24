import { randomBytes } from "node:crypto";
import {
  ServiceNowAuthError,
  ServiceNowOutcomeUnknownError,
  ServiceNowPermissionError,
  ServiceNowUnavailableError,
  type AccessRequestRecord,
  type CreateAccessRequestInput,
} from "@aoo/servicenow";
import type { ServiceNowAccessRequestGateway } from "../../src/index.js";

export type CreateBehavior =
  | "ok"
  | "lost-before-receipt" // request never processed; client sees a timeout
  | "lost-after-create" // provider creates the record; client sees a timeout
  | "503-after-create"
  | "503-before-create"
  | "malformed-after-create" // 201 with unreadable body
  | "refused"
  | "auth"
  | "permission"
  | "drop-agent-reason" // provider silently drops a field (e.g. missing field ACL)
  | { hold: Promise<void> } // wait, then behave like "ok"
  | "hang-until-abort";

/**
 * In-memory ServiceNow double. Enforces the table's UNIQUE correlation_key exactly like the real
 * instance (a duplicate insert is rejected with 403, as ServiceNow reports insert failures).
 */
export class FakeServiceNow implements ServiceNowAccessRequestGateway {
  readonly records: AccessRequestRecord[] = [];
  readonly createBehaviors: CreateBehavior[] = [];
  posts = 0;
  queries = 0;
  /** Makes the next N queries return nothing even if a record exists (eventual consistency). */
  hideFromNextQueries = 0;
  private seq = 1000;

  insert(
    input: CreateAccessRequestInput,
    overrides: Partial<AccessRequestRecord> = {},
  ): AccessRequestRecord {
    const record: AccessRequestRecord = {
      sysId: randomBytes(16).toString("hex"),
      sysClassName: "x_test_onboarding_access_request",
      number: `OAR000${++this.seq}`,
      state: "1",
      shortDescription: input.shortDescription,
      createdOn: "2026-09-24 10:00:00",
      updatedOn: "2026-09-24 10:00:00",
      employeeId: input.employeeId,
      workflowId: input.workflowId,
      resourceId: input.resourceId,
      requestedEntitlement: input.requestedEntitlement,
      agentReason: input.agentReason ?? "",
      policyDecision: input.policyDecision,
      correlationKey: input.correlationKey,
      ...overrides,
    };
    this.records.push(record);
    return record;
  }

  private insertUnique(
    input: CreateAccessRequestInput,
    overrides: Partial<AccessRequestRecord> = {},
  ) {
    if (this.records.some((r) => r.correlationKey === input.correlationKey)) {
      throw new ServiceNowPermissionError("createAccessRequest", "unique key violation");
    }
    return this.insert(input, overrides);
  }

  byKey(correlationKey: string) {
    return this.records.filter((r) => r.correlationKey === correlationKey);
  }

  async queryAccessRequests(query: { correlationKey?: string } = {}) {
    this.queries++;
    if (this.hideFromNextQueries > 0) {
      this.hideFromNextQueries--;
      return [];
    }
    return this.records.filter((r) => r.correlationKey === query.correlationKey).slice(0, 2);
  }

  async getAccessRequest(sysId: string) {
    return this.records.find((r) => r.sysId === sysId) ?? null;
  }

  async createAccessRequest(
    input: CreateAccessRequestInput,
    options: { signal?: AbortSignal } = {},
  ) {
    this.posts++;
    const behavior = this.createBehaviors.shift() ?? "ok";
    const op = "createAccessRequest";
    if (typeof behavior === "object") {
      await behavior.hold;
      return this.insertUnique(input);
    }
    switch (behavior) {
      case "ok":
        return this.insertUnique(input);
      case "lost-before-receipt":
        throw new ServiceNowOutcomeUnknownError(
          op,
          "no response within 10000ms or before the deadline",
        );
      case "lost-after-create":
        this.insertUnique(input);
        throw new ServiceNowOutcomeUnknownError(op, "connection lost (ECONNRESET)");
      case "503-after-create":
        this.insertUnique(input);
        throw new ServiceNowOutcomeUnknownError(op, "instance returned 503", { status: 503 });
      case "503-before-create":
        throw new ServiceNowOutcomeUnknownError(op, "instance returned 503", { status: 503 });
      case "malformed-after-create":
        this.insertUnique(input);
        throw new ServiceNowOutcomeUnknownError(
          op,
          "created response unreadable: response is not valid JSON",
          { status: 201 },
        );
      case "refused":
        throw new ServiceNowUnavailableError(
          op,
          "connection failed before sending (ECONNREFUSED)",
          { notSent: true },
        );
      case "auth":
        throw new ServiceNowAuthError(op);
      case "permission":
        throw new ServiceNowPermissionError(op);
      case "drop-agent-reason":
        return this.insertUnique(input, { agentReason: "" });
      case "hang-until-abort":
        await new Promise<void>((_, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new ServiceNowOutcomeUnknownError(op, "no response within the deadline")),
          ),
        );
        throw new Error("unreachable");
    }
  }
}
