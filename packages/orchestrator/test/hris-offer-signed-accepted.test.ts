import type { OnboardingWorkflow } from "@aoo/db";
import { describe, expect, it, vi } from "vitest";
import { InvalidTransitionError, WorkflowVersionConflictError } from "../src/errors.js";
import {
  createHrisOfferSignedAcceptedHandler,
  workflowStartKey,
} from "../src/events/hris-offer-signed-accepted.js";
import { PermanentEventError, noopLogger, type EventEnvelope } from "../src/events/types.js";
import type { WorkflowDetails, WorkflowService } from "../src/workflow-service.js";

const workflowId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const payload = {
  workflowId,
  workflowCreated: true,
  receiptId: "0b0f7c1e-4a5c-4e8e-9a51-7a4a3f0f6d11",
  hrisEventId: "evt-1",
  hrisEventType: "offer.signed",
  hrisEmployeeId: "E-1",
};
const envelope = (p: unknown = payload): EventEnvelope => ({
  id: "outbox-1",
  type: "hris.offer_signed.accepted",
  payload: p,
  correlationId: "hris:evt-1",
  aggregateType: "onboarding_workflow",
  aggregateId: workflowId,
  deliveryAttempt: 1,
});

function fakeWorkflows(state: OnboardingWorkflow["state"] = "RECEIVED", version = 1) {
  const workflow = { id: workflowId, state, version } as OnboardingWorkflow;
  return {
    getWorkflow: vi.fn<WorkflowService["getWorkflow"]>(
      async () => ({ workflow }) as WorkflowDetails,
    ),
    transition: vi.fn<WorkflowService["transition"]>(async () => ({
      ...workflow,
      state: "ACCESS_PLANNING",
      version: version + 1,
    })),
    createWorkflow: vi.fn<WorkflowService["createWorkflow"]>(),
    listAuditEvents: vi.fn<WorkflowService["listAuditEvents"]>(),
  } satisfies WorkflowService;
}

const ctx = { logger: noopLogger };

describe("hris.offer_signed.accepted handler", () => {
  it("starts a newly created workflow with a stable idempotency key", async () => {
    const workflows = fakeWorkflows("RECEIVED", 1);
    const result = await createHrisOfferSignedAcceptedHandler(workflows)(envelope(), ctx);

    expect(workflows.transition).toHaveBeenCalledWith(
      {
        workflowId,
        to: "ACCESS_PLANNING",
        expectedVersion: 1,
        actor: "outbox-worker",
        correlationId: "hris:evt-1",
        idempotencyKey: workflowStartKey(workflowId),
      },
      // (M10) the access-planning request commits with the start
      { effects: expect.any(Function) },
    );
    expect(result).toEqual({
      status: "processed",
      detail: { workflowId, state: "ACCESS_PLANNING", version: 2 },
    });
  });

  it("acknowledges a reused active workflow without reading or transitioning it", async () => {
    const workflows = fakeWorkflows();
    const result = await createHrisOfferSignedAcceptedHandler(workflows)(
      envelope({ ...payload, workflowCreated: false }),
      ctx,
    );
    expect(result).toMatchObject({
      status: "skipped",
      detail: { reason: "ACTIVE_WORKFLOW_REUSED" },
    });
    expect(workflows.getWorkflow).not.toHaveBeenCalled();
    expect(workflows.transition).not.toHaveBeenCalled();
  });

  it("skips a workflow that left RECEIVED without being started by the worker", async () => {
    const workflows = fakeWorkflows("FAILED", 2);
    workflows.transition.mockRejectedValue(new InvalidTransitionError("FAILED", "ACCESS_PLANNING"));
    const result = await createHrisOfferSignedAcceptedHandler(workflows)(envelope(), ctx);
    expect(result).toMatchObject({
      status: "skipped",
      detail: { reason: "WORKFLOW_NOT_IN_RECEIVED", state: "FAILED" },
    });
  });

  it("rethrows version conflicts so the event is retried", async () => {
    const workflows = fakeWorkflows();
    workflows.transition.mockRejectedValue(new WorkflowVersionConflictError(workflowId, 1, 2));
    await expect(
      createHrisOfferSignedAcceptedHandler(workflows)(envelope(), ctx),
    ).rejects.toBeInstanceOf(WorkflowVersionConflictError);
  });

  it("treats malformed payloads and missing workflows as permanent", async () => {
    const workflows = fakeWorkflows();
    await expect(
      createHrisOfferSignedAcceptedHandler(workflows)(envelope({ workflowId: "x" }), ctx),
    ).rejects.toBeInstanceOf(PermanentEventError);

    workflows.getWorkflow.mockResolvedValue(null);
    await expect(
      createHrisOfferSignedAcceptedHandler(workflows)(envelope(), ctx),
    ).rejects.toBeInstanceOf(PermanentEventError);
  });
});
