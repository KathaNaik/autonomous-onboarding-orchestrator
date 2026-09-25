import { describe, expect, it } from "vitest";
import { serviceNowAccessRequestKeys } from "../src/external-operations/keys.js";
import { logicalDecisionKey } from "../src/index.js";

const decisionInput = {
  agentRunId: "00000000-0000-4000-8000-000000000001",
  resourceId: "cursor-license",
  catalogVersion: "1.0.0",
  catalogHash: `sha256:${"a".repeat(64)}`,
  policyVersion: "1.1.0",
  policyHash: `sha256:${"b".repeat(64)}`,
  employeeFactsSourceEventId: "evt-1",
  departmentCode: "ENGINEERING",
  roleFamilyCode: "SOFTWARE_ENGINEER",
  employmentType: "CONTRACTOR",
};

describe("logicalDecisionKey", () => {
  it("is deterministic and independent of key order", () => {
    const reversed = Object.fromEntries(
      Object.entries(decisionInput).reverse(),
    ) as typeof decisionInput;
    expect(logicalDecisionKey(reversed)).toBe(logicalDecisionKey(decisionInput));
    expect(logicalDecisionKey(decisionInput)).toMatch(/^access-decision:[0-9a-f]{64}$/);
  });

  it.each(Object.keys(decisionInput))("changes when %s changes", (field) => {
    const changed = {
      ...decisionInput,
      [field]: `${decisionInput[field as keyof typeof decisionInput]}x`,
    };
    expect(logicalDecisionKey(changed)).not.toBe(logicalDecisionKey(decisionInput));
  });
});

describe("serviceNowAccessRequestKeys with an access decision (M6B)", () => {
  const identity = {
    workflowId: "wf-1",
    resourceId: "cursor-license",
    requestedEntitlement: "Cursor license",
  };

  it("keeps M4B keys unchanged when no decision is given", () => {
    expect(serviceNowAccessRequestKeys(identity).idempotencyKey).toBe(
      "servicenow.create_access_request:wf-1:cursor-license:Cursor license",
    );
    expect(serviceNowAccessRequestKeys({ ...identity, accessDecisionId: undefined })).toEqual(
      serviceNowAccessRequestKeys(identity),
    );
  });

  it("ties the keys to the decision, one ticket per decision", () => {
    const a = serviceNowAccessRequestKeys({ ...identity, accessDecisionId: "d-1" });
    const b = serviceNowAccessRequestKeys({ ...identity, accessDecisionId: "d-2" });
    expect(a.idempotencyKey).toContain("decision=d-1");
    expect(a.correlationKey).not.toBe(b.correlationKey);
    expect(a.correlationKey).not.toBe(serviceNowAccessRequestKeys(identity).correlationKey);
    expect(a.correlationKey).toMatch(/^aoo-oar-[0-9a-f]{40}$/);
  });
});
