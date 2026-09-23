import { describe, expect, it } from "vitest";
import { CreateWorkflowInputSchema, TransitionInputSchema } from "../src/schemas.js";

const workflowId = "0b0f7c1e-4a5c-4e8e-9a51-7a4a3f0f6d11";

describe("TransitionInputSchema", () => {
  it("accepts a valid transition", () => {
    const input = { workflowId, to: "ACCESS_PLANNING", expectedVersion: 1, actor: "system" };
    expect(TransitionInputSchema.parse(input)).toEqual(input);
  });

  it("requires a reason when failing a workflow", () => {
    const base = { workflowId, to: "FAILED", expectedVersion: 3, actor: "system" };
    expect(TransitionInputSchema.safeParse(base).success).toBe(false);
    expect(TransitionInputSchema.safeParse({ ...base, reason: "okta down" }).success).toBe(true);
  });

  it("rejects unknown states, non-positive versions and bad ids", () => {
    const base = { workflowId, to: "ACCESS_PLANNING", expectedVersion: 1, actor: "system" };
    expect(TransitionInputSchema.safeParse({ ...base, to: "DONE" }).success).toBe(false);
    expect(TransitionInputSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(false);
    expect(TransitionInputSchema.safeParse({ ...base, workflowId: "abc" }).success).toBe(false);
    expect(TransitionInputSchema.safeParse({ ...base, actor: " " }).success).toBe(false);
  });
});

describe("CreateWorkflowInputSchema", () => {
  it("requires a well-formed employee", () => {
    const employee = {
      hrisEmployeeId: "E-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    };
    expect(CreateWorkflowInputSchema.safeParse({ employee, actor: "system" }).success).toBe(true);
    expect(
      CreateWorkflowInputSchema.safeParse({
        employee: { ...employee, email: "x" },
        actor: "system",
      }).success,
    ).toBe(false);
  });
});
