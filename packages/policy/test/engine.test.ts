import { describe, expect, it } from "vitest";
import {
  CURRENT_POLICY_VERSION,
  loadPolicyRegistry,
  type PolicyDecision,
  type PolicySubject,
} from "../src/index.js";
import { catalogRef, policyError, subject } from "./helpers.js";

const policy = loadPolicyRegistry().current;

const decide = (resourceId: string, who: Partial<PolicySubject> = {}) =>
  policy.evaluate({ subject: subject(who), catalog: catalogRef, resourceId });

const summary = (d: PolicyDecision) => [d.resourceId, d.decision, d.matchedRuleId, d.reasonCode];

describe("current released policy (1.1.0, synthetic demo data)", () => {
  it("allows the engineering baseline with the exact rule and reason", () => {
    const d = decide("github-org-membership");
    expect(d).toEqual({
      resourceId: "github-org-membership",
      decision: "ALLOW",
      matchedRuleId: "engineering-baseline",
      reasonCode: "ENGINEERING_BASELINE",
      explanation:
        "Engineering hires receive the engineering baseline: identity group, GitHub organization, Slack and Jira.",
      policyVersion: CURRENT_POLICY_VERSION,
      policyHash: policy.policyHash,
      catalogVersion: catalogRef.catalogVersion,
      catalogHash: catalogRef.catalogHash,
      dependsOn: [],
    });
  });

  it("requires approval for aws-prod", () => {
    expect(summary(decide("aws-prod"))).toEqual([
      "aws-prod",
      "REQUIRES_APPROVAL",
      "production-access-approval",
      "PRODUCTION_ACCESS_REQUIRES_APPROVAL",
    ]);
  });

  it("denies resources outside the department's scope with an explicit rule", () => {
    expect(
      summary(decide("aws-dev", { department: "SALES", roleFamily: "ACCOUNT_EXECUTIVE" })),
    ).toEqual(["aws-dev", "DENY", "non-engineering-cloud-deny", "DEPARTMENT_NOT_AUTHORIZED"]);
  });

  it("denies by default when no rule matches", () => {
    const sales = { department: "SALES", roleFamily: "ACCOUNT_EXECUTIVE" };
    expect(summary(decide("slack-engineering", sales))).toEqual([
      "slack-engineering",
      "DENY",
      "builtin.default-deny",
      "NO_MATCHING_ALLOW_RULE",
    ]);
    // Engineering department, but a role family the team rule doesn't cover.
    expect(decide("github-team-backend", { roleFamily: "PRODUCT_MANAGER" }).reasonCode).toBe(
      "NO_MATCHING_ALLOW_RULE",
    );
  });

  it("fails closed for unknown and disabled resources", () => {
    expect(summary(decide("github-enterprise-admin"))).toEqual([
      "github-enterprise-admin",
      "DENY",
      "builtin.unknown-resource",
      "UNKNOWN_RESOURCE",
    ]);
    expect(summary(decide("aws-staging"))).toEqual([
      "aws-staging",
      "DENY",
      "builtin.disabled-resource",
      "RESOURCE_DISABLED",
    ]);
  });

  it("gives SREs (canonical code SRE) engineering team access", () => {
    expect(summary(decide("github-team-backend", { roleFamily: "SRE" }))).toEqual([
      "github-team-backend",
      "ALLOW",
      "engineering-source-teams",
      "ENGINEERING_TEAM_ACCESS",
    ]);
  });

  it("fails closed for employment types the policy doesn't declare", () => {
    const d = decide("github-org-membership", { employmentType: "INTERN" });
    expect(summary(d)).toEqual([
      "github-org-membership",
      "DENY",
      "builtin.unknown-subject-attribute",
      "UNKNOWN_SUBJECT_ATTRIBUTE",
    ]);
    expect(policy.snapshot().subjectAttributes.employmentTypes).toEqual([
      "CONTRACTOR",
      "FULL_TIME",
    ]);
  });

  it("fails closed for departments or role families the policy doesn't define", () => {
    expect(decide("github-org-membership", { department: "LEGAL" }).reasonCode).toBe(
      "UNKNOWN_SUBJECT_ATTRIBUTE",
    );
    expect(decide("github-org-membership", { roleFamily: "DATA_SCIENTIST" }).matchedRuleId).toBe(
      "builtin.unknown-subject-attribute",
    );
  });

  describe("precedence: DENY > REQUIRES_APPROVAL > ALLOW > default DENY", () => {
    it("explicit DENY beats REQUIRES_APPROVAL", () => {
      // production-access-approval also matches a contractor; the deny rule wins.
      expect(summary(decide("aws-prod", { employmentType: "CONTRACTOR" }))).toEqual([
        "aws-prod",
        "DENY",
        "non-employee-production-deny",
        "NON_EMPLOYEE_PRODUCTION_ACCESS_DENIED",
      ]);
    });

    it("REQUIRES_APPROVAL beats ALLOW", () => {
      // engineering-developer-tools also matches; the approval rule wins.
      expect(summary(decide("cursor-license", { employmentType: "CONTRACTOR" }))).toEqual([
        "cursor-license",
        "REQUIRES_APPROVAL",
        "contractor-license-approval",
        "CONTRACTOR_LICENSE_REQUIRES_APPROVAL",
      ]);
      expect(decide("cursor-license").matchedRuleId).toBe("engineering-developer-tools");
    });
  });

  it("is deterministic and returns frozen decisions", () => {
    const a = decide("aws-prod");
    const b = decide("aws-prod");
    expect(b).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.dependsOn)).toBe(true);
  });
});

describe("evaluateAll", () => {
  const request = (resourceIds: string[], who: Partial<PolicySubject> = {}) =>
    policy.evaluateAll({ subject: subject(who), catalog: catalogRef, resourceIds });

  it("returns one independent decision per resource, whatever the request order", () => {
    const ids = ["aws-prod", "github-team-backend", "aws-staging", "github-org-membership", "nope"];
    const forward = request(ids);
    const reversed = request([...ids].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.map(summary)).toEqual([
      [
        "aws-prod",
        "REQUIRES_APPROVAL",
        "production-access-approval",
        "PRODUCTION_ACCESS_REQUIRES_APPROVAL",
      ],
      ["aws-staging", "DENY", "builtin.disabled-resource", "RESOURCE_DISABLED"],
      ["github-org-membership", "ALLOW", "engineering-baseline", "ENGINEERING_BASELINE"],
      ["github-team-backend", "ALLOW", "engineering-source-teams", "ENGINEERING_TEAM_ACCESS"],
      ["nope", "DENY", "builtin.unknown-resource", "UNKNOWN_RESOURCE"],
    ]);
  });

  it("doesn't let a resource awaiting approval affect an allowed one", () => {
    const alone = decide("aws-dev");
    const withApproval = request(["aws-prod", "aws-dev"]).find((d) => d.resourceId === "aws-dev");
    expect(withApproval).toEqual(alone);
    expect(alone.decision).toBe("ALLOW");
  });

  it("rejects duplicate resource ids", () => {
    expect(policyError(() => request(["aws-dev", "aws-dev"])).code).toBe("DUPLICATE_RESOURCE");
  });
});

describe("dependencies", () => {
  it("reports catalog dependencies without deciding them", () => {
    const team = decide("github-team-backend");
    expect(team.dependsOn).toEqual(["github-org-membership"]);
    // Deciding the team neither decides nor adds its dependency: only requested ids are decided.
    const decisions = policy.evaluateAll({
      subject: subject(),
      catalog: catalogRef,
      resourceIds: ["github-team-backend"],
    });
    expect(decisions.map(summary)).toEqual([
      ["github-team-backend", "ALLOW", "engineering-source-teams", "ENGINEERING_TEAM_ACCESS"],
    ]);
    expect(decide("aws-prod").dependsOn).toEqual(["aws-dev"]);
  });

  it("decides a resource and its dependency independently", () => {
    // aws-prod needs approval while its dependency aws-dev is allowed outright.
    const [dev, prod] = policy.evaluateAll({
      subject: subject(),
      catalog: catalogRef,
      resourceIds: ["aws-prod", "aws-dev"],
    });
    expect([dev!.decision, prod!.decision]).toEqual(["ALLOW", "REQUIRES_APPROVAL"]);
  });
});

describe("requests", () => {
  it("rejects a request for another catalog version or hash", () => {
    const wrongHash = { ...catalogRef, catalogHash: `sha256:${"0".repeat(64)}` };
    const wrongVersion = { ...catalogRef, catalogVersion: "9.9.9" };
    for (const catalog of [wrongHash, wrongVersion]) {
      const err = policyError(() =>
        policy.evaluate({ subject: subject(), catalog, resourceId: "aws-dev" }),
      );
      expect(err.code).toBe("CATALOG_MISMATCH");
    }
  });

  it("accepts only explicit facts, never free-text role descriptions", () => {
    const err = policyError(() =>
      policy.evaluate({
        subject: { ...subject(), jobDescription: "Builds backend services" } as never,
        catalog: catalogRef,
        resourceId: "aws-dev",
      }),
    );
    expect(err.code).toBe("INVALID_REQUEST");
    expect(
      policyError(() =>
        policy.evaluate({
          subject: subject({ department: "Engineering" }),
          catalog: catalogRef,
          resourceId: "aws-dev",
        }),
      ).code,
    ).toBe("INVALID_REQUEST");
  });
});

describe("snapshot", () => {
  it("exposes frozen metadata for the version", () => {
    const snapshot = policy.snapshot();
    expect(snapshot.policyVersion).toBe("1.1.0");
    expect(snapshot.policyHash).toBe(policy.policyHash);
    expect(snapshot.catalog).toEqual(catalogRef);
    expect(snapshot.ruleCount).toBe(9);
    expect(policy.snapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot.rules[0]!.when)).toBe(true);
    expect(() => (snapshot.rules as unknown[]).pop()).toThrow(TypeError);
    expect(snapshot.rules.map((r) => r.ruleId)).toEqual(
      [...snapshot.rules.map((r) => r.ruleId)].sort(),
    );
  });
});
