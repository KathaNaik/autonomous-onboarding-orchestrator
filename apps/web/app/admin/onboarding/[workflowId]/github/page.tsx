import Link from "next/link";
import { loadWebConfig } from "@/lib/config";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { fetchGitHubIdentity } from "@/lib/github-identity-api";
import { RESULT_MESSAGES, statusLines } from "@/lib/github-identity-status";

export const dynamic = "force-dynamic";

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
  return (
    <main>
      <p>
        <Link href={`/admin/onboarding/${encodeURIComponent(workflowId)}`}>← Workflow</Link>
      </p>
      <h1>GitHub Account</h1>
      <p>
        For HR and onboarding staff. Record the GitHub username the employee gave you. They should
        create the account with their company email address.
      </p>
      {notice && <p role="status">{notice}</p>}
      {!result.ok ? (
        <p role="alert">
          {result.status === 404 ? "Onboarding not found." : "Could not load this onboarding."}
        </p>
      ) : (
        <>
          <p>
            Employee: {result.body.employee.firstName} {result.body.employee.lastName}
            <br />
            Work email: {result.body.employee.workEmail}
          </p>
          {result.body.identity.state !== "RESOLVED" ? (
            <form
              method="post"
              action={`/admin/onboarding/${encodeURIComponent(workflowId)}/github/save`}
              autoComplete="off"
            >
              <label htmlFor="githubLogin">GitHub username</label>{" "}
              <input
                id="githubLogin"
                name="githubLogin"
                defaultValue={result.body.identity.claimedLogin ?? ""}
                maxLength={39}
                pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}"
                spellCheck={false}
                required
              />{" "}
              <button type="submit">Save GitHub Account</button>
            </form>
          ) : (
            <p>The GitHub account is linked. Changing it needs administrator remediation.</p>
          )}
          <h2>Status</h2>
          <ul>
            {statusLines(result.body).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
