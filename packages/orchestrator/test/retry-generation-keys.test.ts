import { describe, expect, it } from "vitest";
import {
  githubOrgMembershipKeys,
  githubTeamMembershipKeys,
  oktaMembershipKeys,
  serviceNowAccessRequestKeys,
  serviceNowFulfillmentKeys,
} from "../src/index.js";

/** M13: the retry generation gives fresh keys, and generation 0 keeps every existing key. */
const ids = {
  accessDecisionId: "00000000-0000-4000-8000-000000000001",
  accessRequestId: "00000000-0000-4000-8000-000000000002",
};
const builders: [
  string,
  (generation?: number) => { idempotencyKey: string; correlationKey: string },
][] = [
  [
    "servicenow approval ticket",
    (generation) =>
      serviceNowAccessRequestKeys({
        workflowId: "00000000-0000-4000-8000-000000000003",
        resourceId: "aws-prod",
        requestedEntitlement: "AWS production account",
        accessDecisionId: ids.accessDecisionId,
        ...(generation !== undefined && { generation }),
      }),
  ],
  [
    "servicenow fulfillment",
    (generation) =>
      serviceNowFulfillmentKeys({
        ...ids,
        resourceId: "slack-engineering",
        ...(generation !== undefined && { generation }),
      }),
  ],
  [
    "okta membership",
    (generation) =>
      oktaMembershipKeys({
        ...ids,
        groupId: "00g000000000000",
        ...(generation !== undefined && { generation }),
      }),
  ],
  [
    "github org",
    (generation) =>
      githubOrgMembershipKeys({
        ...ids,
        org: "aoo-sandbox",
        githubUserId: 42,
        ...(generation !== undefined && { generation }),
      }),
  ],
  [
    "github team",
    (generation) =>
      githubTeamMembershipKeys({
        ...ids,
        org: "aoo-sandbox",
        teamId: 7,
        githubUserId: 42,
        ...(generation !== undefined && { generation }),
      }),
  ],
];

describe.each(builders)("%s keys", (_name, keys) => {
  it("generation 0 equals the original (pre-M13) keys", () => {
    expect(keys(0)).toEqual(keys());
    expect(keys().idempotencyKey).not.toMatch(/gen=/);
  });
  it("each generation yields new, distinct idempotency and correlation keys", () => {
    const [g0, g1, g2] = [keys(0), keys(1), keys(2)];
    expect(g1.idempotencyKey).toBe(`${g0.idempotencyKey}:gen=1`);
    expect(new Set([g0.correlationKey, g1.correlationKey, g2.correlationKey]).size).toBe(3);
    expect(keys(1)).toEqual(g1);
  });
});
