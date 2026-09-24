import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/index.js";
import { catalogRef, catalogs, loadIssues, policyDocument, rule } from "./helpers.js";

const has = (issues: readonly string[], fragment: string) =>
  expect(
    issues.some((issue) => issue.includes(fragment)),
    issues.join("\n"),
  ).toBe(true);

describe("policy load validation", () => {
  it("loads a valid policy", () => {
    const engine = new PolicyEngine(policyDocument(), catalogs);
    expect(engine.snapshot().ruleCount).toBe(1);
  });

  it("rejects duplicate rule ids", () => {
    const doc = policyDocument([
      rule("baseline"),
      rule("baseline", { when: { departments: ["SALES"], resourceIds: ["slack-engineering"] } }),
    ]);
    has(loadIssues(doc), 'duplicate rule id "baseline"');
  });

  it("rejects invalid decisions and malformed conditions", () => {
    has(
      loadIssues(policyDocument([rule("a", { decision: "MAYBE" as never })])),
      "rules.0.decision",
    );
    has(
      loadIssues(
        policyDocument([rule("a", { when: { departments: [], resourceIds: ["aws-dev"] } })]),
      ),
      "must not be empty",
    );
    has(
      loadIssues(policyDocument([rule("a", { when: { resourceIds: ["aws-dev", "aws-dev"] } })])),
      "must not repeat values",
    );
    has(
      loadIssues(policyDocument([rule("a", { when: { categories: ["CLOUD"] } as never })])),
      "rules.0.when",
    );
    has(
      loadIssues(policyDocument([rule("a", { when: { environments: ["QA"] } as never })])),
      "rules.0.when.environments",
    );
    has(
      loadIssues(policyDocument([rule("a", { when: { departments: ["Engineering"] } as never })])),
      "UPPER_SNAKE_CASE",
    );
    has(loadIssues(policyDocument([rule("Bad_Id")])), "rule id must be lowercase kebab-case");
  });

  it("rejects unknown and disabled resource references", () => {
    has(
      loadIssues(
        policyDocument([rule("a", { when: { resourceIds: ["github-enterprise-admin"] } })]),
      ),
      'references unknown resource "github-enterprise-admin"',
    );
    has(
      loadIssues(policyDocument([rule("a", { when: { resourceIds: ["aws-staging"] } })])),
      'references disabled resource "aws-staging"',
    );
  });

  it("rejects an unknown catalog version or a catalog hash mismatch", () => {
    const unknownVersion = {
      ...policyDocument(),
      catalog: { ...catalogRef, catalogVersion: "2.0.0" },
    };
    has(loadIssues(unknownVersion), "catalog reference 2.0.0 is not usable");
    const wrongHash = {
      ...policyDocument(),
      catalog: { ...catalogRef, catalogHash: `sha256:${"f".repeat(64)}` },
    };
    has(loadIssues(wrongHash), "does not match catalog");
  });

  it("rejects rules naming an employment type the policy doesn't declare", () => {
    const doc = policyDocument([
      rule("baseline"),
      rule("interns", {
        decision: "DENY",
        when: { employmentTypes: ["INTERN"], resourceIds: ["aws-dev"] },
      }),
    ]);
    doc.subjectAttributes.employmentTypes = ["FULL_TIME", "CONTRACTOR"];
    has(loadIssues(doc), "names employment type INTERN, which is not in subjectAttributes");
  });

  it("rejects vocabulary violations, reserved reason codes and unscoped rules", () => {
    has(
      loadIssues(
        policyDocument([rule("a", { when: { departments: ["LEGAL"], resourceIds: ["aws-dev"] } })]),
      ),
      "names department LEGAL",
    );
    has(
      loadIssues(
        policyDocument([
          rule("a", { when: { roleFamilies: ["DATA_SCIENTIST"], resourceIds: ["aws-dev"] } }),
        ]),
      ),
      "names role family DATA_SCIENTIST",
    );
    has(loadIssues(policyDocument([rule("a", { reasonCode: "UNKNOWN_RESOURCE" })])), "reserved");
    has(
      loadIssues(policyDocument([rule("a", { when: { departments: ["ENGINEERING"] } })])),
      "ALLOW without a resource condition",
    );
    has(
      loadIssues(policyDocument([rule("a", { decision: "DENY", when: {} })])),
      "has no conditions",
    );
  });

  it("rejects overlapping rules of the same effect as ambiguous", () => {
    const doc = policyDocument([
      rule("baseline"),
      rule("everyone-github", { when: { providers: ["GITHUB"] } }),
    ]);
    has(loadIssues(doc), "ambiguous ALLOW rules [baseline, everyone-github]");
    const denies = policyDocument([
      rule("baseline"),
      rule("deny-a", { decision: "DENY", when: { environments: ["PRODUCTION"] } }),
      rule("deny-b", { decision: "DENY", when: { resourceIds: ["aws-prod"] } }),
    ]);
    has(loadIssues(denies), "ambiguous DENY rules [deny-a, deny-b]");
  });

  it("accepts overlapping rules of different effects: precedence resolves them", () => {
    const doc = policyDocument([
      rule("github", { when: { departments: ["ENGINEERING"], providers: ["GITHUB"] } }),
      rule("team-approval", {
        decision: "REQUIRES_APPROVAL",
        when: { resourceIds: ["github-team-backend"] },
      }),
    ]);
    expect(() => new PolicyEngine(doc, catalogs)).not.toThrow();
  });

  it("rejects unreachable rules", () => {
    const shadowed = policyDocument([
      rule("baseline"),
      rule("deny-all-github", { decision: "DENY", when: { providers: ["GITHUB"] } }),
    ]);
    has(loadIssues(shadowed), 'rule "baseline" is unreachable');
    const matchesNothing = policyDocument([
      rule("baseline"),
      rule("staging", { when: { environments: ["STAGING"] } }),
    ]);
    has(loadIssues(matchesNothing), 'rule "staging" is unreachable');
  });

  it("reports every problem together", () => {
    const doc = policyDocument([
      rule("a", { when: { resourceIds: ["ghost"] } }),
      rule("a", { when: { departments: ["LEGAL"], resourceIds: ["aws-dev"] } }),
      rule("b", { reasonCode: "NO_MATCHING_ALLOW_RULE" }),
    ]);
    expect(loadIssues(doc).length).toBeGreaterThanOrEqual(4);
  });
});
