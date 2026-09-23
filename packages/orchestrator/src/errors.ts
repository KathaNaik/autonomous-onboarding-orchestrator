import type { WorkflowState } from "@aoo/shared";

export class WorkflowNotFoundError extends Error {
  readonly code = "WORKFLOW_NOT_FOUND";

  constructor(readonly workflowId: string) {
    super(`workflow ${workflowId} not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";

  constructor(
    readonly from: WorkflowState,
    readonly to: WorkflowState,
  ) {
    super(`invalid workflow transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** The caller's expectedVersion is stale: another transition was committed first. */
export class WorkflowVersionConflictError extends Error {
  readonly code = "WORKFLOW_VERSION_CONFLICT";

  constructor(
    readonly workflowId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `workflow ${workflowId} version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "WorkflowVersionConflictError";
  }
}

/** Authenticated, well-formed event that is not allowed to start onboarding. */
export class HrisEventNotEligibleError extends Error {
  readonly code = "HRIS_EVENT_NOT_ELIGIBLE";

  constructor(
    readonly eventId: string,
    readonly offerStatus: string,
    readonly candidateStatus: string,
  ) {
    super(
      `event ${eventId} cannot start onboarding (offerStatus=${offerStatus}, candidateStatus=${candidateStatus})`,
    );
    this.name = "HrisEventNotEligibleError";
  }
}

/** An eventId that was already accepted arrived again with different content. */
export class HrisEventConflictError extends Error {
  readonly code = "HRIS_EVENT_CONFLICT";

  constructor(readonly eventId: string) {
    super(`event ${eventId} was already accepted with a different payload`);
    this.name = "HrisEventConflictError";
  }
}
