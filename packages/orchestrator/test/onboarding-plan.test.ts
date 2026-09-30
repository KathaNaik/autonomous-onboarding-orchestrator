import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPARTMENT_CODES, EMPLOYMENT_TYPE_CODES, ROLE_FAMILY_CODES } from "@aoo/shared";
import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  OnboardingPlanError,
  PermanentEventError,
  ROLE_FAMILY_LABELS,
  SETTLED_REQUEST_STATUSES,
  availabilityOf,
  createOnboardingPlanGenerateHandler,
  isSettledForPlanning,
  onboardingPlanGenerationDisabledHandler,
  scrubContextText,
  type OnboardingPlanGenerationResult,
} from "../src/index.js";

const WF = "3f1c2b9a-1d2e-4f5a-9b8c-7d6e5f4a3b2c";
const envelope = (payload: unknown) => ({
  id: "e1",
  type: "onboarding.plan.generate",
  payload,
  correlationId: null,
  aggregateType: "onboarding_workflow",
  aggregateId: WF,
  deliveryAttempt: 1,
});
const ctx = { logger: { debug() {}, info() {}, warn() {}, error() {} } };
const result = (
  outcome: OnboardingPlanGenerationResult["outcome"],
): OnboardingPlanGenerationResult => ({
  outcome,
  workflowId: WF,
  workflowState: outcome === "NOT_APPLICABLE" ? "PROVISIONING" : "COMPLETED",
  onboardingPlanId: null,
  onboardingPlanRunId: null,
  modelCalls: 0,
});

describe("model-facing context", () => {
  it("labels every canonical fact code with human-readable text (never the code)", () => {
    const check = (codes: readonly string[], labels: Record<string, string>) => {
      expect(Object.keys(labels).sort()).toEqual([...codes].sort());
      for (const code of codes) {
        expect(labels[code]).not.toContain("_");
        expect(labels[code]).not.toBe(code);
      }
    };
    check(DEPARTMENT_CODES, DEPARTMENT_LABELS);
    check(ROLE_FAMILY_CODES, ROLE_FAMILY_LABELS);
    check(EMPLOYMENT_TYPE_CODES, EMPLOYMENT_TYPE_LABELS);
  });

  it("maps settled states to availability without revealing why (policy denial = human rejection)", () => {
    expect(availabilityOf("PROVISIONED")).toBe("AVAILABLE");
    expect(availabilityOf("DENIED")).toBe("NOT_AVAILABLE");
    expect(availabilityOf("REJECTED")).toBe("NOT_AVAILABLE");
    for (const status of [
      "READY_FOR_PROVISIONING",
      "PROVISIONING",
      "PROVISIONING_FAILED",
      "AWAITING_APPROVAL",
      "MANUAL_ACTION_REQUIRED",
    ]) {
      expect(() => availabilityOf(status)).toThrow();
    }
  });

  it("scrubs secret-like tokens and URL credentials from HRIS free text", () => {
    const text =
      "Owns deploys. token sk-proj-abcdefghijklmnop0123 and ghp_abcdefghijklmnopqrstuvwxyz0123 via https://user:pw@host.example Bearer abcdefghijklmnop";
    const out = scrubContextText(text, 4000)!;
    for (const secret of [
      "sk-proj-abcdefghijklmnop0123",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "user:pw@",
      "abcdefghijklmnop",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("Owns deploys.");
    expect(scrubContextText("   ", 100)).toBeNull();
    expect(scrubContextText("x".repeat(300), 200)).toHaveLength(200);
  });
});

describe("settled-state predicate (deterministic)", () => {
  const req = (status: string, orchestrationBlocker: string | null = null) =>
    ({ status, orchestrationBlocker }) as never;

  it("is true only when every request is PROVISIONED, DENIED or REJECTED without a blocker", () => {
    expect([...SETTLED_REQUEST_STATUSES]).toEqual(["PROVISIONED", "DENIED", "REJECTED"]);
    expect(isSettledForPlanning([])).toBe(true); // zero resources
    expect(isSettledForPlanning([req("DENIED"), req("REJECTED")])).toBe(true); // all unavailable
    expect(isSettledForPlanning([req("PROVISIONED"), req("DENIED")])).toBe(true);
  });

  it.each([
    "READY_FOR_PROVISIONING",
    "PROVISIONING",
    "PROVISIONING_FAILED",
    "AWAITING_APPROVAL",
    "MANUAL_ACTION_REQUIRED",
  ])("is false while any request is %s", (status) => {
    expect(isSettledForPlanning([req("PROVISIONED"), req(status)])).toBe(false);
  });

  it("is false when a settled request still carries an orchestration blocker", () => {
    expect(isSettledForPlanning([req("DENIED", "DEPENDENCIES_NOT_READY")])).toBe(false);
  });
});

describe("onboarding.plan.generate handler", () => {
  const handlerWith = (impl: () => Promise<OnboardingPlanGenerationResult>) =>
    createOnboardingPlanGenerateHandler({ generatePlan: impl });

  it("COMPLETED is processed; replays and non-applicable workflows are skipped", async () => {
    expect(
      await handlerWith(async () => result("COMPLETED"))(
        envelope({ workflowId: WF, reason: "PROVISIONING_SETTLED" }),
        ctx,
      ),
    ).toMatchObject({ status: "processed" });
    expect(
      await handlerWith(async () => result("ALREADY_COMPLETED"))(
        envelope({ workflowId: WF, reason: "SCHEDULED_RECOVERY" }),
        ctx,
      ),
    ).toMatchObject({ status: "skipped" });
    expect(
      await handlerWith(async () => result("NOT_APPLICABLE"))(
        envelope({ workflowId: WF, reason: "SCHEDULED_RECOVERY" }),
        ctx,
      ),
    ).toMatchObject({ status: "skipped" });
  });

  it("retries transient failures and dead-letters deterministic ones", async () => {
    const busy = handlerWith(async () => {
      throw new OnboardingPlanError("BUSY", "busy", { retryable: true });
    });
    const retryErr = await busy(
      envelope({ workflowId: WF, reason: "PROVISIONING_SETTLED" }),
      ctx,
    ).catch((e) => e);
    expect(retryErr).not.toBeInstanceOf(PermanentEventError);
    for (const err of [
      new OnboardingPlanError("ONBOARDING_INPUT_NOT_SETTLED", "x", { blocked: true }),
      new OnboardingPlanError("RUN_FAILED", "x", { category: "INVALID_PLAN" }),
    ]) {
      const failed = await handlerWith(async () => {
        throw err;
      })(envelope({ workflowId: WF, reason: "PROVISIONING_SETTLED" }), ctx).catch((e) => e);
      expect(failed).toBeInstanceOf(PermanentEventError);
    }
    await expect(
      handlerWith(async () => result("COMPLETED"))(envelope({ workflowId: "nope" }), ctx),
    ).rejects.toBeInstanceOf(PermanentEventError);
  });

  it("acknowledges requests as disabled when generation is off", async () => {
    expect(
      await onboardingPlanGenerationDisabledHandler(
        envelope({ workflowId: WF, reason: "PROVISIONING_SETTLED" }),
        ctx,
      ),
    ).toMatchObject({
      status: "skipped",
      detail: { outcome: "ONBOARDING_PLAN_GENERATION_DISABLED" },
    });
  });
});

describe("boundaries", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const sources = (rel: string) => {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    return readdirSync(dir).map((f) => [f, readFileSync(`${dir}/${f}`, "utf8")] as const);
  };

  it("the onboarding-plan module never touches provisioning adapters, providers or authorization writes", () => {
    for (const [file, source] of sources("../src/onboarding-plan/")) {
      expect(source, file).not.toMatch(
        /@aoo\/(servicenow|okta|github)|provision(Okta|GitHub|ServiceNow)Access|coordinateProvisioning|authorizeAgentRun|insert\(access(Decisions|Requests)\)|update\(access(Decisions|Requests)\)|update\(approvals\)/,
      );
    }
  });

  it("only the onboarding-plan service moves a workflow to COMPLETED", () => {
    const offenders: string[] = [];
    const walk = (rel: string) => {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
        else if (/to: "COMPLETED"/.test(readFileSync(`${dir}/${entry.name}`, "utf8")))
          offenders.push(`${rel}${entry.name}`);
      }
    };
    walk("../src/");
    expect(offenders).toEqual(["../src/onboarding-plan/service.ts"]);
    // …and it does so in the same transaction that persists the accepted plan.
    const service = read("../src/onboarding-plan/service.ts");
    const transition = service.slice(service.indexOf('to: "COMPLETED"'));
    expect(transition.indexOf("effects:")).toBeGreaterThan(0);
    expect(transition.indexOf(".insert(onboardingPlans)")).toBeGreaterThan(
      transition.indexOf("effects:"),
    );
  });

  it("the provisioning coordinator requests the plan inside the ONBOARDING_GENERATION transition", () => {
    const coordinator = read("../src/provisioning/coordinator.ts");
    const transition = coordinator.slice(coordinator.indexOf('to: "ONBOARDING_GENERATION"'));
    const effects = transition.slice(
      transition.indexOf("effects:"),
      transition.indexOf("return applied"),
    );
    expect(effects).toContain("enqueueOnboardingPlanGeneration(tx");
  });
});
