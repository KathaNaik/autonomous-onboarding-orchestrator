// Local HRIS simulator: signs synthetic offer.signed events and POSTs them to the API.
// Run `pnpm hris:simulate --help` from the repo root for options.
import { parseArgs } from "node:util";
import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  HRIS_CANDIDATE_STATUSES,
  HRIS_OFFER_STATUSES,
  ROLE_FAMILY_CODES,
} from "@aoo/shared";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  HIRE_PROFILE_NAMES,
  buildOfferSignedEvent,
  deliver,
  loadEvent,
  saveEvent,
  signEvent,
  type EventOverrides,
} from "./events.js";

const HELP = `Usage: pnpm hris:simulate [options]

  --count <n>              distinct events to send (default 1)
  --repeat <n>             deliveries of each event, sent concurrently (default 1)
  --event-id <id>          fixed eventId (only with --count 1). Other fields are random each run,
                           so reusing an accepted id from an earlier run returns 409 by design
  --save <file>            write the (last) generated event to a file
  --from-file <file>       resend an exact event from a file (a true HRIS retry)
  --employee-id <id>       fixed HRIS employeeId (e.g. to reuse an employee)
  --offer-status <s>       ${HRIS_OFFER_STATUSES.join(" | ")} (default SIGNED)
  --candidate-status <s>   ${HRIS_CANDIDATE_STATUSES.join(" | ")} (default CLEARED)
  --profile <p>            ${HIRE_PROFILE_NAMES.join(" | ")} (default random)
  --department-code <c>    ${DEPARTMENT_CODES.join(" | ")} (overrides the profile)
  --role-family <c>        ${ROLE_FAMILY_CODES.join(" | ")} (overrides the profile)
  --employment-type <t>    ${EMPLOYMENT_TYPE_CODES.join(" | ")} (overrides the profile)
  --bad-signature          sign with a wrong secret (expect 401)
  --url <url>              override HRIS_WEBHOOK_URL
  --print                  print the event JSON without sending
Env: HRIS_WEBHOOK_SECRET (required), HRIS_WEBHOOK_URL (default http://localhost:4000/webhooks/hris)`;

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "1" },
    repeat: { type: "string", default: "1" },
    "event-id": { type: "string" },
    "employee-id": { type: "string" },
    "offer-status": { type: "string" },
    "candidate-status": { type: "string" },
    profile: { type: "string" },
    "department-code": { type: "string" },
    "role-family": { type: "string" },
    "employment-type": { type: "string" },
    "bad-signature": { type: "boolean", default: false },
    url: { type: "string" },
    print: { type: "boolean", default: false },
    save: { type: "string" },
    "from-file": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const args = z
  .object({
    count: z.coerce.number().int().min(1).max(1000),
    repeat: z.coerce.number().int().min(1).max(100),
    eventId: z.string().min(1).optional(),
    employeeId: z.string().min(1).optional(),
    offerStatus: z.enum(HRIS_OFFER_STATUSES).optional(),
    candidateStatus: z.enum(HRIS_CANDIDATE_STATUSES).optional(),
    profile: z.enum(HIRE_PROFILE_NAMES).optional(),
    departmentCode: z.enum(DEPARTMENT_CODES).optional(),
    roleFamilyCode: z.enum(ROLE_FAMILY_CODES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPE_CODES).optional(),
  })
  .refine((a) => a.eventId === undefined || a.count === 1, "--event-id requires --count 1")
  .parse({
    count: values.count,
    repeat: values.repeat,
    eventId: values["event-id"],
    employeeId: values["employee-id"],
    offerStatus: values["offer-status"],
    candidateStatus: values["candidate-status"],
    profile: values.profile,
    departmentCode: values["department-code"],
    roleFamilyCode: values["role-family"],
    employmentType: values["employment-type"],
  });

const overrides: EventOverrides = {
  ...(args.eventId && { eventId: args.eventId }),
  ...(args.employeeId && { employeeId: args.employeeId }),
  ...(args.offerStatus && { offerStatus: args.offerStatus }),
  ...(args.candidateStatus && { candidateStatus: args.candidateStatus }),
  ...(args.departmentCode && { departmentCode: args.departmentCode }),
  ...(args.roleFamilyCode && { roleFamilyCode: args.roleFamilyCode }),
  ...(args.employmentType && { employmentType: args.employmentType }),
};

if (values.print) {
  console.log(JSON.stringify(buildOfferSignedEvent(overrides, args.profile), null, 2));
  process.exit(0);
}

const config = loadConfig();
const url = values.url ?? config.HRIS_WEBHOOK_URL;
const secret = values["bad-signature"]
  ? `${config.HRIS_WEBHOOK_SECRET}-wrong`
  : config.HRIS_WEBHOOK_SECRET;

let failures = 0;
const fromFile = values["from-file"];
const count = fromFile ? 1 : args.count;
for (let i = 0; i < count; i++) {
  const event = fromFile ? loadEvent(fromFile) : buildOfferSignedEvent(overrides, args.profile);
  if (values.save) saveEvent(values.save, event);
  const request = signEvent(event, secret);
  const results = await Promise.all(
    Array.from({ length: args.repeat }, () => deliver(url, request)),
  );
  for (const { status, body } of results) {
    if (status !== 202) failures += 1;
    console.log(
      JSON.stringify({ eventId: event.eventId, employeeId: event.employeeId, status, body }),
    );
  }
}
process.exitCode = failures > 0 ? 1 : 0;
