import { OnboardingPlanGeneratePayloadSchema } from "@aoo/shared";
import { OnboardingPlanError, type OnboardingPlanService } from "../onboarding-plan/service.js";
import { PermanentEventError, type EventHandler } from "./types.js";

/**
 * onboarding.plan.generate → OnboardingPlanService.generatePlan (M8). Idempotent under
 * at-least-once delivery and concurrent workers. Transient failures (provider outage, a busy run,
 * lost ownership) are retried by the outbox; deterministic failures (unsettled or inconsistent
 * context, a permanently failed run) dead-letter visibly and are not re-woken by the sweeper.
 */
export function createOnboardingPlanGenerateHandler(
  service: Pick<OnboardingPlanService, "generatePlan">,
): EventHandler {
  return async (event) => {
    const parsed = OnboardingPlanGeneratePayloadSchema.safeParse(event.payload);
    if (!parsed.success) throw new PermanentEventError("invalid onboarding.plan.generate payload");
    try {
      const result = await service.generatePlan({ workflowId: parsed.data.workflowId });
      return {
        status: result.outcome === "COMPLETED" ? "processed" : "skipped",
        detail: {
          reason: parsed.data.reason,
          outcome: result.outcome,
          workflowState: result.workflowState,
          onboardingPlanId: result.onboardingPlanId,
          onboardingPlanRunId: result.onboardingPlanRunId,
          modelCalls: result.modelCalls,
        },
      };
    } catch (err) {
      if (err instanceof OnboardingPlanError && !err.retryable) {
        throw new PermanentEventError(`onboarding plan generation stopped: ${err.code}`);
      }
      if (err instanceof OnboardingPlanError) {
        throw new Error(`onboarding plan generation will be retried: ${err.code}`);
      }
      throw err;
    }
  };
}

/** Registered when plan generation is disabled: acknowledges the request; recovery re-enqueues later. */
export const onboardingPlanGenerationDisabledHandler: EventHandler = async () => ({
  status: "skipped",
  detail: { outcome: "ONBOARDING_PLAN_GENERATION_DISABLED" },
});
