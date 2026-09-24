import { randomUUID } from "node:crypto";
import type { HrisOfferSignedEvent } from "@aoo/shared";
import type { CreateWorkflowInput } from "../../src/index.js";

export function newEmployee(): CreateWorkflowInput["employee"] {
  const id = randomUUID().slice(0, 8);
  return {
    hrisEmployeeId: `HRIS-${id}`,
    email: `new.hire.${id}@example.com`,
    firstName: "New",
    lastName: `Hire ${id}`,
  };
}

export function newOfferSignedEvent(
  overrides: Partial<HrisOfferSignedEvent> = {},
): HrisOfferSignedEvent {
  const e = newEmployee();
  return {
    eventId: `evt-${randomUUID()}`,
    eventType: "offer.signed",
    occurredAt: new Date().toISOString(),
    employeeId: e.hrisEmployeeId,
    employee: { firstName: e.firstName, lastName: e.lastName, email: e.email },
    role: "Software Engineer",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "SOFTWARE_ENGINEER",
    employmentType: "FULL_TIME",
    managerId: "HRIS-MGR-1",
    offerStatus: "SIGNED",
    candidateStatus: "CLEARED",
    ...overrides,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
