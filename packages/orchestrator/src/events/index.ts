import { OUTBOX_EVENT_TYPES } from "@aoo/shared";
import type { WorkflowService } from "../workflow-service.js";
import type { ApprovalService } from "../approvals/service.js";
import type { ExternalOperationService } from "../external-operations/service.js";
import type { ProvisioningCoordinator } from "../provisioning/coordinator.js";
import type { OnboardingPlanService } from "../onboarding-plan/service.js";
import type { AccessPlanningService } from "../access-planning/service.js";
import {
  accessPlanningDisabledHandler,
  createAccessPlanningRequestedHandler,
} from "./access-planning-requested.js";
import { createApprovalCallbackHandler } from "./approval-callback-received.js";
import { createExternalOperationExecuteHandler } from "./external-operation-execute.js";
import { createHrisOfferSignedAcceptedHandler } from "./hris-offer-signed-accepted.js";
import {
  createOnboardingPlanGenerateHandler,
  onboardingPlanGenerationDisabledHandler,
} from "./onboarding-plan-generate.js";
import { createProvisioningWorkflowWakeHandler } from "./provisioning-workflow-wake.js";
import type { EventHandlerRegistry } from "./types.js";

export * from "./access-planning-requested.js";
export * from "./approval-callback-received.js";
export * from "./external-operation-execute.js";
export * from "./hris-offer-signed-accepted.js";
export * from "./onboarding-plan-generate.js";
export * from "./provisioning-workflow-wake.js";
export * from "./types.js";

export function createEventHandlers(deps: {
  workflows: WorkflowService;
  /** When set, the worker executes durable external operations (e.g. ServiceNow tickets). */
  externalOperations?: { service: ExternalOperationService; ownerId: string; leaseMs: number };
  /** When set, the worker verifies ServiceNow approval callbacks. */
  approvals?: ApprovalService;
  /** (M7C) When set, the worker drives provisioning on provisioning.workflow.wake. */
  provisioning?: Pick<ProvisioningCoordinator, "coordinateProvisioning">;
  /**
   * (M8) When set, the worker generates onboarding plans on onboarding.plan.generate; otherwise
   * those requests are acknowledged as disabled (the recovery sweep re-enqueues them once enabled).
   */
  onboardingPlans?: Pick<OnboardingPlanService, "generatePlan">;
  /**
   * (M10) When set, the worker runs the Role Access Agent and the policy authorization on
   * access.planning.requested; otherwise those requests are acknowledged as disabled (the
   * recovery sweep re-enqueues them once enabled).
   */
  accessPlanning?: Pick<AccessPlanningService, "planAccess">;
}): EventHandlerRegistry {
  return {
    [OUTBOX_EVENT_TYPES.hrisOfferSignedAccepted]: createHrisOfferSignedAcceptedHandler(
      deps.workflows,
    ),
    ...(deps.externalOperations && {
      [OUTBOX_EVENT_TYPES.externalOperationExecute]: createExternalOperationExecuteHandler(
        deps.externalOperations.service,
        deps.externalOperations,
      ),
    }),
    ...(deps.approvals && {
      [OUTBOX_EVENT_TYPES.approvalCallbackReceived]: createApprovalCallbackHandler(deps.approvals),
    }),
    ...(deps.provisioning && {
      [OUTBOX_EVENT_TYPES.provisioningWorkflowWake]: createProvisioningWorkflowWakeHandler(
        deps.provisioning,
      ),
    }),
    [OUTBOX_EVENT_TYPES.accessPlanningRequested]: deps.accessPlanning
      ? createAccessPlanningRequestedHandler(deps.accessPlanning)
      : accessPlanningDisabledHandler,
    [OUTBOX_EVENT_TYPES.onboardingPlanGenerate]: deps.onboardingPlans
      ? createOnboardingPlanGenerateHandler(deps.onboardingPlans)
      : onboardingPlanGenerationDisabledHandler,
  };
}
