import { randomUUID } from "node:crypto";
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
const ROLES = [
  ["Software Engineer", "Engineering"],
  ["Data Analyst", "Analytics"],
  ["Account Executive", "Sales"],
  ["People Partner", "People"],
] as const;

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

export type EventOverrides = Partial<Omit<HrisOfferSignedEvent, "employee">> & {
  employee?: Partial<HrisOfferSignedEvent["employee"]>;
};

/** A synthetic, schema-valid offer.signed event. Defaults to an eligible (signed + cleared) hire. */
export function buildOfferSignedEvent(overrides: EventOverrides = {}): HrisOfferSignedEvent {
  const suffix = randomUUID().slice(0, 8);
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const [role, department] = pick(ROLES);
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
    role,
    department,
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
