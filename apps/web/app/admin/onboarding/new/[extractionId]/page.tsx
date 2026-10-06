import {
  DEPARTMENT_CODES,
  EMPLOYMENT_TYPE_CODES,
  ROLE_FAMILY_CODES,
  ROLE_FAMILY_DEPARTMENTS,
} from "@aoo/shared";
import Link from "next/link";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { humanize } from "@/lib/dashboard-model";
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
const warningText = (w: string) =>
  w.startsWith("SENSITIVE_CONTENT_REMOVED:")
    ? `Compensation or personal details were removed from “${humanize(w.split(":")[1] ?? "")}”.`
    : w.startsWith("CODE_REMOVED:")
      ? `A code-like value was removed from “${humanize(w.split(":")[1] ?? "")}”; codes are chosen below, never taken from the letter.`
      : w.startsWith("INSTRUCTION_REMOVED:")
        ? `Text addressed to the AI was removed from “${humanize(w.split(":")[1] ?? "")}”.`
        : (WARNING_TEXT[w] ?? humanize(w));

const field = { display: "grid", gap: 4 } as const;

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
  return (
    <main>
      <p>
        <Link href="/admin/onboarding/new">← Upload another letter</Link>
      </p>
      <h1>Review the new hire</h1>
      {!result.ok ? (
        <p role="alert">
          {OFFER_ERROR_MESSAGES[result.body.error] ?? "Could not load this letter."}
        </p>
      ) : result.body.status === "SUBMITTED" && result.body.workflowId ? (
        <p role="status">
          This letter already started an onboarding.{" "}
          <Link href={`/admin/onboarding/${result.body.workflowId}`}>Open the workflow</Link>
        </p>
      ) : (
        <>
          <p>
            The fields below were proposed by the Offer Letter Extractor. Check each one against the
            letter. The access-relevant choices at the bottom are yours: they are not taken from the
            letter.
          </p>
          {result.body.proposal.warnings.length > 0 && (
            <ul aria-label="warnings">
              {result.body.proposal.warnings.map((w) => (
                <li key={w}>{warningText(w)}</li>
              ))}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
          <form
            method="post"
            action={`/admin/onboarding/new/${encodeURIComponent(extractionId)}/start`}
            style={{ display: "grid", gap: 14, maxWidth: 640, marginTop: 12 }}
          >
            <fieldset style={{ display: "grid", gap: 12 }}>
              <legend>Hire (from the letter)</legend>
              <label style={field}>
                First name
                <input
                  name="firstName"
                  required
                  maxLength={100}
                  defaultValue={result.body.proposal.firstName ?? ""}
                />
              </label>
              <label style={field}>
                Last name
                <input
                  name="lastName"
                  required
                  maxLength={100}
                  defaultValue={result.body.proposal.lastName ?? ""}
                />
              </label>
              <label style={field}>
                Work email
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  defaultValue={result.body.proposal.workEmail ?? ""}
                />
              </label>
              <label style={field}>
                Job title
                <input
                  name="role"
                  required
                  maxLength={200}
                  defaultValue={result.body.proposal.jobTitle ?? ""}
                />
              </label>
              <label style={field}>
                Department (as written)
                <input
                  name="department"
                  required
                  maxLength={200}
                  defaultValue={result.body.proposal.department ?? ""}
                />
              </label>
              <label style={field}>
                Manager
                <input
                  name="managerId"
                  required
                  maxLength={200}
                  defaultValue={result.body.proposal.managerName ?? ""}
                />
              </label>
              <label style={field}>
                Job description (optional, helps the Role Access Agent)
                <textarea
                  name="jobDescription"
                  rows={4}
                  maxLength={4000}
                  defaultValue={result.body.proposal.jobSummary ?? ""}
                />
              </label>
              {result.body.proposal.startDate && (
                <p style={{ margin: 0 }}>
                  <small>Start date in the letter: {result.body.proposal.startDate}</small>
                </p>
              )}
            </fieldset>
            <fieldset style={{ display: "grid", gap: 12 }}>
              <legend>Access-relevant facts (you choose; the AI never sets these)</legend>
              <label style={field}>
                Department code
                <select name="departmentCode" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {DEPARTMENT_CODES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={field}>
                Role family
                <select name="roleFamilyCode" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {ROLE_FAMILY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)} ({ROLE_FAMILY_DEPARTMENTS[c].map(humanize).join(", ")})
                    </option>
                  ))}
                </select>
              </label>
              <label style={field}>
                Employment type
                <select name="employmentType" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {EMPLOYMENT_TYPE_CODES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" name="offerSignedAndCleared" value="true" required />
              <span>
                I confirm the offer is signed and the candidate is cleared to start onboarding.
              </span>
            </label>
            <button type="submit" style={{ justifySelf: "start" }}>
              Start onboarding
            </button>
          </form>
        </>
      )}
    </main>
  );
}
