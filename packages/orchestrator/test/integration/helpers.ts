import { randomUUID } from "node:crypto";
import { CATALOG_RELEASES, CatalogRegistry } from "@aoo/catalog";
import { POLICY_RELEASES, PolicyRegistry } from "@aoo/policy";
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

/**
 * (M14) Catalog 1.0.0 + policy 1.1.0 as the current releases: aws-dev and slack-engineering are
 * ServiceNow-fulfilled there, which these suites use as their fulfillment examples. Workflows
 * bound to these releases keep them (the plan's exact catalog), so this path stays real.
 */
export function releasesBeforeM14() {
  const catalogs = new CatalogRegistry({ releases: CATALOG_RELEASES, currentVersion: "1.0.0" });
  const policies = new PolicyRegistry({
    releases: POLICY_RELEASES,
    currentVersion: "1.1.0",
    catalogs,
  });
  return { catalogs, policies };
}
