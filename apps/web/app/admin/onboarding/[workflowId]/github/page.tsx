import { ConsoleShell } from "@/components/console/shell";
import {
  Button,
  Callout,
  Card,
  Field,
  PageHeader,
  StatusBadge,
  cx,
  styles as s,
} from "@/components/console/ui";
import { loadWebConfig } from "@/lib/config";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { fetchGitHubIdentity } from "@/lib/github-identity-api";
import { RESULT_MESSAGES, statusLines } from "@/lib/github-identity-status";

export const dynamic = "force-dynamic";

const IDENTITY_BADGE = {
  NOT_SUBMITTED: { tone: "amber", label: "Not provided" },
  SUBMITTED: { tone: "blue", label: "Username recorded" },
  RESOLVED: { tone: "green", label: "Account linked" },
} as const;

/**
 * HR/onboarding staff (M7B): record the GitHub username an employee provided. Not
 * employee-facing. (M10) Server-rendered behind the M9 operator session: no token field, no
 * client JavaScript; the form posts to a server handler that calls the API with the server-only
 * token and the session's operator id.
 */
export default async function GitHubAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  const { workflowId } = await params;
  const query = (await searchParams) ?? {};
  const notice = typeof query.result === "string" ? RESULT_MESSAGES[query.result] : undefined;
  const result = await fetchGitHubIdentity(workflowId, {
    adminToken: loadWebConfig().ONBOARDING_ADMIN_TOKEN ?? "",
    operatorId: session.operatorId,
    sessionNonce: session.nonce,
  });
  if (!result.ok) redirectIfUnauthorized(result.status);
  const saved = query.result === "saved" || query.result === "unchanged";
  return (
    <ConsoleShell active="workflows" operatorId={session.operatorId}>
      <PageHeader
        title="GitHub Account"
        description="For HR and onboarding staff. Record the GitHub username the employee gave you. They should create the account with their company email address."
        back={{
          href: `/admin/onboarding/${encodeURIComponent(workflowId)}`,
          label: "Back to workflow",
        }}
      />
      {notice && <Callout tone={saved ? "green" : "red"} role="status" title={notice} />}
      {!result.ok ? (
        <Callout
          tone="red"
          role="alert"
          title={
            result.status === 404 ? "Onboarding not found." : "Could not load this onboarding."
          }
        />
      ) : (
        <div className={s.twoCol}>
          <Card className={s.cardBody}>
            <div className={s.stackMd} style={{ gap: 20 }}>
              <div className={s.stack}>
                <span className={cx(s.muted, s.small)}>Employee</span>
                <span className={s.primaryText}>
                  {result.body.employee.firstName} {result.body.employee.lastName}
                </span>
                <span className={s.muted}>{result.body.employee.workEmail}</span>
              </div>
              {result.body.identity.state !== "RESOLVED" ? (
                <form
                  method="post"
                  action={`/admin/onboarding/${encodeURIComponent(workflowId)}/github/save`}
                  autoComplete="off"
                  className={s.stackMd}
                  style={{ gap: 16 }}
                >
                  <Field
                    label="GitHub username"
                    htmlFor="githubLogin"
                    hint="Swift sends a real GitHub organization invitation to this account, so use your own username. Letters, digits and single hyphens, up to 39 characters."
                  >
                    <input
                      id="githubLogin"
                      name="githubLogin"
                      defaultValue={result.body.identity.claimedLogin ?? ""}
                      maxLength={39}
                      pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}"
                      spellCheck={false}
                      required
                      className={s.input}
                    />
                  </Field>
                  <div>
                    <Button>Save GitHub Account</Button>
                  </div>
                </form>
              ) : (
                <Callout tone="green" title="The GitHub account is linked.">
                  Changing it needs administrator remediation.
                </Callout>
              )}
            </div>
          </Card>
          <Card className={s.cardBody}>
            <div className={s.stackMd} style={{ gap: 12 }}>
              <div className={s.cluster} style={{ justifyContent: "space-between" }}>
                <h2 className={s.sectionTitle}>Status</h2>
                <StatusBadge
                  tone={IDENTITY_BADGE[result.body.identity.state].tone}
                  label={IDENTITY_BADGE[result.body.identity.state].label}
                  code={result.body.identity.state}
                />
              </div>
              <ul className={s.stack} style={{ paddingLeft: 18, gap: 6 }}>
                {statusLines(result.body).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className={cx(s.muted, s.small)}>
                The organization invitation goes to this exact account, so only its owner can accept
                it. Org membership counts as provisioned only after acceptance.
              </p>
            </div>
          </Card>
        </div>
      )}
    </ConsoleShell>
  );
}
