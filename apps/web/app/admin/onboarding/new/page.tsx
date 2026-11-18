import { ConsoleShell } from "@/components/console/shell";
import * as I from "@/components/console/icons";
import { Button, Callout, PageHeader, Steps, cx, styles as s } from "@/components/console/ui";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { OFFER_ERROR_MESSAGES } from "@/lib/offer-letter-api";
import { fetchSessionStatus } from "@/lib/onboarding-read-api";
import { NEW_ONBOARDING_STEPS } from "@/lib/console-model";

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
      <ConsoleShell active="new" operatorId={session.operatorId}>
        <Callout
          tone="red"
          role="alert"
          title="The onboarding service is unavailable. Try again shortly."
        />
      </ConsoleShell>
    );
  }
  const params = await searchParams;
  const error = typeof params.error === "string" ? OFFER_ERROR_MESSAGES[params.error] : undefined;
  return (
    <ConsoleShell active="new" operatorId={session.operatorId}>
      <PageHeader
        title="New onboarding"
        description="Upload the signed offer letter. Swift reads it and pre-fills the hire's details; you check every field and choose the access-relevant facts before anything starts."
        back={{ href: "/admin/onboarding", label: "All workflows" }}
      />
      <Steps steps={NEW_ONBOARDING_STEPS} current={0} />
      <section className={s.stackMd} style={{ gap: 20 }}>
        <form
          method="post"
          action="/admin/onboarding/new/upload"
          encType="multipart/form-data"
          className={s.stackMd}
          style={{ gap: 20 }}
        >
          {error && <Callout tone="red" role="alert" title={error} />}
          <div className={s.upload}>
            <span style={{ color: "var(--muted)" }}>
              <I.FileDoc size={32} />
            </span>
            <div className={s.stack}>
              <label htmlFor="offerLetter" className={s.subTitle}>
                Offer letter (PDF)
              </label>
              <span className={cx(s.muted, s.small)}>PDF only, up to 4 MB</span>
            </div>
            <input
              id="offerLetter"
              name="offerLetter"
              type="file"
              accept="application/pdf,.pdf"
              required
              className={s.fileInput}
            />
          </div>
          <div className={s.actions} style={{ justifyContent: "space-between" }}>
            <p
              className={cx(s.muted, s.small)}
              style={{ maxWidth: "64ch", display: "flex", gap: 8 }}
            >
              <span style={{ flex: "none", marginTop: 2 }}>
                <I.Lock size={14} />
              </span>
              The PDF is analyzed temporarily and is not stored by Swift. Salary and other
              compensation are never retained.
            </p>
            <Button>Read offer letter</Button>
          </div>
        </form>
        <div className={s.sampleNote}>
          <p>
            <strong>No offer letter to hand?</strong>{" "}
            <a href="/sample-offer-letter.pdf" download>
              Download a sample letter
            </a>{" "}
            (a fictional engineer at a fictional company). On the review page, give the hire a
            unique email address: Swift creates a staged Okta account with that login.
          </p>
          <p className={s.muted}>
            You can start one onboarding a day, and read up to three letters a day.
          </p>
        </div>
      </section>
    </ConsoleShell>
  );
}
