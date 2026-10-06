import Link from "next/link";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { fetchSessionStatus } from "@/lib/onboarding-read-api";
import { OFFER_ERROR_MESSAGES } from "@/lib/offer-letter-api";

export const dynamic = "force-dynamic";

/**
 * (M11) Start an onboarding from an offer letter: step 1, upload. A plain HTML form posting to a
 * server handler (no client JavaScript); the PDF is read by the Offer Letter Extractor and discarded.
 */
export default async function NewOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  // This page makes no other API call: confirm the session wasn't logged out (revoked) elsewhere.
  const status = await fetchSessionStatus(session);
  if (!status.ok) redirectIfUnauthorized(status.status);
  if (!status.ok) {
    return (
      <main>
        <p role="alert">The onboarding service is unavailable. Try again shortly.</p>
      </main>
    );
  }
  const params = await searchParams;
  const error = typeof params.error === "string" ? OFFER_ERROR_MESSAGES[params.error] : undefined;
  return (
    <main>
      <p>
        <Link href="/admin/onboarding">← All workflows</Link>
      </p>
      <h1>New onboarding</h1>
      <p>
        Upload the signed offer letter (PDF, 4 MB max). Swift&apos;s Offer Letter Extractor reads it
        and pre-fills the hire&apos;s details; you review everything and choose the access-relevant
        department, role family and employment type before anything starts.
      </p>
      <p>
        <small>
          The PDF is not stored. Only the reviewed details (never salary or other compensation) are
          kept.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        method="post"
        action="/admin/onboarding/new/upload"
        encType="multipart/form-data"
        style={{ display: "grid", gap: 12, maxWidth: 520, marginTop: 16 }}
      >
        <label htmlFor="offerLetter">Offer letter (PDF)</label>
        <input
          id="offerLetter"
          name="offerLetter"
          type="file"
          accept="application/pdf,.pdf"
          required
        />
        <button type="submit" style={{ justifySelf: "start" }}>
          Read offer letter
        </button>
      </form>
    </main>
  );
}
