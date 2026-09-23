import { randomUUID } from "node:crypto";
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
