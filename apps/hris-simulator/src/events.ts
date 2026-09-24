import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { HrisOfferSignedEventSchema, type HrisOfferSignedEvent } from "@aoo/shared";
import { HRIS_SIGNATURE_HEADER, signHrisPayload } from "@aoo/webhooks";

const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Linus", "Margaret", "Dennis", "Barbara"];
const LAST = [
  "Lovelace",
  "Hopper",
  "Turing",
  "Johnson",
  "Torvalds",
  "Hamilton",
  "Ritchie",
  "Liskov",
];
/**
 * Synthetic hire profiles: display text plus the canonical facts HRIS asserts. The display text
 * deliberately differs from the codes; the codes are authoritative.
 */
export const HIRE_PROFILES = {
  engineering: {
    role: "Backend Software Engineer",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "SOFTWARE_ENGINEER",
    employmentType: "FULL_TIME",
  },
  sre: {
    role: "Site Reliability Engineer",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "SRE",
    employmentType: "FULL_TIME",
  },
  "engineering-manager": {
    role: "Engineering Manager, Platform",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "ENGINEERING_MANAGER",
    employmentType: "FULL_TIME",
  },
  contractor: {
    role: "Frontend Engineer (Contract)",
    department: "Engineering",
    departmentCode: "ENGINEERING",
    roleFamilyCode: "SOFTWARE_ENGINEER",
    employmentType: "CONTRACTOR",
  },
  product: {
    role: "Senior Product Manager",
    department: "Product",
    departmentCode: "PRODUCT",
    roleFamilyCode: "PRODUCT_MANAGER",
    employmentType: "FULL_TIME",
  },
  sales: {
    role: "Account Executive, Mid-Market",
    department: "Sales",
    departmentCode: "SALES",
    roleFamilyCode: "ACCOUNT_EXECUTIVE",
    employmentType: "FULL_TIME",
  },
} as const satisfies Record<
  string,
  Pick<
    HrisOfferSignedEvent,
    "role" | "department" | "departmentCode" | "roleFamilyCode" | "employmentType"
  >
>;
export type HireProfile = keyof typeof HIRE_PROFILES;
export const HIRE_PROFILE_NAMES = Object.keys(HIRE_PROFILES) as HireProfile[];

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

export type EventOverrides = Partial<Omit<HrisOfferSignedEvent, "employee">> & {
  employee?: Partial<HrisOfferSignedEvent["employee"]>;
};

/**
 * A synthetic, schema-valid offer.signed event. Defaults to an eligible (signed + cleared) hire
 * with a random profile. `profile` picks the display text and canonical facts; explicit
 * overrides win over the profile. Invalid codes or combinations throw (schema validation).
 */
export function buildOfferSignedEvent(
  overrides: EventOverrides = {},
  profile: HireProfile = pick(HIRE_PROFILE_NAMES),
): HrisOfferSignedEvent {
  const suffix = randomUUID().slice(0, 8);
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const { employee, ...rest } = overrides;
  return HrisOfferSignedEventSchema.parse({
    eventId: `sim-evt-${randomUUID()}`,
    eventType: "offer.signed",
    occurredAt: new Date().toISOString(),
    employeeId: `SIM-${suffix}`,
    employee: {
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${suffix}@example.com`.toLowerCase(),
      ...employee,
    },
    ...HIRE_PROFILES[profile],
    managerId: "SIM-MGR-001",
    offerStatus: "SIGNED",
    candidateStatus: "CLEARED",
    ...rest,
  });
}

export interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

/** Serializes and signs exactly as the HRIS webhook protocol requires. */
export function signEvent(event: unknown, secret: string): SignedRequest {
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      "content-type": "application/json",
      [HRIS_SIGNATURE_HEADER]: signHrisPayload(body, secret),
    },
  };
}

export async function deliver(url: string, request: SignedRequest) {
  const res = await fetch(url, { method: "POST", headers: request.headers, body: request.body });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body };
}

/** Writes an event exactly as generated, so a later --from-file resend is a true retry. */
export function saveEvent(path: string, event: HrisOfferSignedEvent): void {
  writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`);
}

/** Reads a saved event and validates it; canonical facts are kept exactly as saved. */
export function loadEvent(path: string): HrisOfferSignedEvent {
  return HrisOfferSignedEventSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
