import { GitHubAccountForm } from "./github-account-form";

export const dynamic = "force-dynamic";

/** HR/onboarding staff (M7B): record the GitHub username an employee provided. Not employee-facing. */
export default async function GitHubAccountPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return (
    <main>
      <h1>GitHub Account</h1>
      <p>
        For HR and onboarding staff. Record the GitHub username the employee gave you. They should
        create the account with their company email address.
      </p>
      <GitHubAccountForm workflowId={workflowId} />
    </main>
  );
}
