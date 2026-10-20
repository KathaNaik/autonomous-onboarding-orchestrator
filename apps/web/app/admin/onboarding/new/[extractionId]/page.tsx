import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  ROLE_FAMILY_CODES,
  ROLE_FAMILY_DEPARTMENTS,
} from "@aoo/shared";
import { ConsoleShell } from "@/components/console/shell";
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  Field,
  PageHeader,
  Section,
  Steps,
  cx,
  styles as s,
} from "@/components/console/ui";
import {
  EMPLOYMENT_LABELS,
  NEW_ONBOARDING_STEPS,
  PROPOSAL_FIELD_LABELS,
  ROLE_FAMILY_LABELS,
  humanize,
} from "@/lib/console-model";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { OFFER_ERROR_MESSAGES, fetchOfferLetter } from "@/lib/offer-letter-api";

export const dynamic = "force-dynamic";

const WARNING_TEXT: Record<string, string> = {
  NOT_AN_OFFER_LETTER: "This document may not be an offer letter.",
  FIELD_NOT_FOUND: "Some details weren't in the letter; fill them in.",
  MULTIPLE_CANDIDATES: "The letter mentions more than one candidate; check the name.",
  UNREADABLE_DOCUMENT: "Parts of the letter couldn't be read.",
  AMBIGUOUS_START_DATE: "No exact start date was found.",
  EMAIL_UNREADABLE: "No valid work email was found; enter it.",
};
const fieldName = (w: string) => {
  const f = w.split(":")[1] ?? "";
  return PROPOSAL_FIELD_LABELS[f] ?? humanize(f);
};
const warningText = (w: string) =>
  w.startsWith("SENSITIVE_CONTENT_REMOVED:")
    ? `Compensation or personal details were removed from “${fieldName(w)}”.`
    : w.startsWith("CODE_REMOVED:")
      ? `A code-like value was removed from “${fieldName(w)}”; codes are chosen below, never taken from the letter.`
      : w.startsWith("INSTRUCTION_REMOVED:")
        ? `Text addressed to the AI was removed from “${fieldName(w)}”.`
        : (WARNING_TEXT[w] ?? humanize(w));

/**
 * (M11) Step 2, review: AI-proposed display fields pre-fill the form; the operator corrects them,
 * chooses the canonical facts (never pre-selected: the AI does not set them) and attests the offer
 * is signed and the candidate cleared. Plain HTML form, server handler, no client JavaScript.
 */
export default async function ReviewOfferLetterPage({
  params,
  searchParams,
}: {
  params: Promise<{ extractionId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  const { extractionId } = await params;
  const query = (await searchParams) ?? {};
  const error = typeof query.error === "string" ? OFFER_ERROR_MESSAGES[query.error] : undefined;
  const result = await fetchOfferLetter(extractionId, session);
  if (!result.ok) redirectIfUnauthorized(result.status);
  const header = (
    <PageHeader
      title="Review the new hire"
      description="Check each field against the letter. You choose the access-driving facts; the AI never does."
      back={{ href: "/admin/onboarding/new", label: "Upload another letter" }}
    />
  );
  if (!result.ok) {
    return (
      <ConsoleShell active="new" operatorId={session.operatorId}>
        {header}
        <Callout
          tone="red"
          role="alert"
          title={OFFER_ERROR_MESSAGES[result.body.error] ?? "Could not load this letter."}
        />
      </ConsoleShell>
    );
  }
  if (result.body.status === "SUBMITTED" && result.body.workflowId) {
    return (
      <ConsoleShell active="new" operatorId={session.operatorId}>
        {header}
        <Callout
          tone="green"
          role="status"
          title="This letter already started an onboarding."
          action={
            <ButtonLink href={`/admin/onboarding/${result.body.workflowId}`} variant="primary">
              Open the workflow
            </ButtonLink>
          }
        />
      </ConsoleShell>
    );
  }
  const p = result.body.proposal;
  return (
    <ConsoleShell active="new" operatorId={session.operatorId}>
      {header}
      <Steps steps={NEW_ONBOARDING_STEPS} current={1} />
      {p.warnings.length > 0 && (
        <Callout tone="amber" title="Check these before you continue">
          <ul aria-label="warnings" style={{ paddingLeft: 18, marginTop: 4 }}>
            {p.warnings.map((w) => (
              <li key={w}>{warningText(w)}</li>
            ))}
          </ul>
        </Callout>
      )}
      {error && <Callout tone="red" role="alert" title={error} />}
      <form
        method="post"
        action={`/admin/onboarding/new/${encodeURIComponent(extractionId)}/start`}
        className={s.stackMd}
        style={{ gap: 32 }}
      >
        <Section
          id="extracted"
          title="Extracted from offer"
          actor={{ kind: "AI", label: "Proposed by AI" }}
          description="Pre-filled by the Offer Letter Extractor. Correct anything that doesn't match the letter."
        >
          <Card className={s.cardBody}>
            <fieldset className={s.fieldset}>
              <legend className={s.skip}>Hire details from the letter</legend>
              <div className={s.formGrid}>
                <Field label="First name" htmlFor="firstName">
                  <input
                    id="firstName"
                    name="firstName"
                    required
                    maxLength={100}
                    defaultValue={p.firstName ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field label="Last name" htmlFor="lastName">
                  <input
                    id="lastName"
                    name="lastName"
                    required
                    maxLength={100}
                    defaultValue={p.lastName ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field label="Work email" htmlFor="email">
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    defaultValue={p.workEmail ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field label="Job title" htmlFor="role">
                  <input
                    id="role"
                    name="role"
                    required
                    maxLength={200}
                    defaultValue={p.jobTitle ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field label="Department (as written)" htmlFor="department">
                  <input
                    id="department"
                    name="department"
                    required
                    maxLength={200}
                    defaultValue={p.department ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field label="Manager" htmlFor="managerId">
                  <input
                    id="managerId"
                    name="managerId"
                    required
                    maxLength={200}
                    defaultValue={p.managerName ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field
                  label="Start date"
                  htmlFor="startDate"
                  hint="The employee's first day. Shown on the onboarding so you can see whether access is ready in time."
                >
                  <input
                    id="startDate"
                    name="startDate"
                    type="date"
                    required
                    defaultValue={p.startDate ?? ""}
                    className={s.input}
                  />
                </Field>
                <Field
                  label="Job description"
                  htmlFor="jobDescription"
                  hint="Optional. Helps the Role Access Agent recommend access; it never authorizes anything."
                  wide
                >
                  <textarea
                    id="jobDescription"
                    name="jobDescription"
                    rows={4}
                    maxLength={4000}
                    defaultValue={p.jobSummary ?? ""}
                    className={s.textarea}
                  />
                </Field>
              </div>
            </fieldset>
          </Card>
        </Section>

        <Section
          id="facts"
          title="Access-driving facts"
          actor={{ kind: "Operator", label: "Chosen by you" }}
          description="These fields affect access policy and must be selected by an operator. They are never chosen by AI."
        >
          <Card className={s.cardBody}>
            <fieldset className={s.fieldset}>
              <legend className={s.skip}>Access-driving facts</legend>
              <div
                className={s.formGrid}
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
              >
                <Field label="Department" htmlFor="departmentCode">
                  <select
                    id="departmentCode"
                    name="departmentCode"
                    required
                    defaultValue=""
                    className={s.select}
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {DEPARTMENT_CODES.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Role family" htmlFor="roleFamilyCode">
                  <select
                    id="roleFamilyCode"
                    name="roleFamilyCode"
                    required
                    defaultValue=""
                    className={s.select}
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {ROLE_FAMILY_CODES.map((c) => (
                      <option key={c} value={c}>
                        {`${ROLE_FAMILY_LABELS[c] ?? humanize(c)} (${ROLE_FAMILY_DEPARTMENTS[c].map(humanize).join(", ")})`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Employment type" htmlFor="employmentType">
                  <select
                    id="employmentType"
                    name="employmentType"
                    required
                    defaultValue=""
                    className={s.select}
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {EMPLOYMENT_TYPE_CODES.map((c) => (
                      <option key={c} value={c}>
                        {EMPLOYMENT_LABELS[c] ?? humanize(c)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </fieldset>
          </Card>
        </Section>

        <section aria-labelledby="start-title" className={s.stackMd} style={{ gap: 16 }}>
          <h2 id="start-title" className={s.sectionTitle}>
            Start onboarding
          </h2>
          <label className={s.attest}>
            <input type="checkbox" name="offerSignedAndCleared" value="true" required />
            <span className={s.stack}>
              <span className={s.primaryText}>
                I confirm the offer is signed and the candidate is cleared to start onboarding.
              </span>
              <span className={cx(s.small)} style={{ color: "var(--gray-fg)" }}>
                Nothing starts without this confirmation. Submitting starts the same onboarding as a
                signed HRIS event, recorded under your name.
              </span>
            </span>
          </label>
          <div className={s.actions}>
            <Button>Start onboarding</Button>
            <ButtonLink href="/admin/onboarding" variant="secondary">
              Cancel
            </ButtonLink>
          </div>
        </section>
      </form>
    </ConsoleShell>
  );
}
