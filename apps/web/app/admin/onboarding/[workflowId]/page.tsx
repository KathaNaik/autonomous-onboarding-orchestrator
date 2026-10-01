import Link from "next/link";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { fetchWorkflowView } from "@/lib/onboarding-read-api";
import { WorkflowView } from "./workflow-view";

export const dynamic = "force-dynamic";

/** (M9) Internal operator view of one onboarding workflow. Server-rendered, read-only. */
export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const session = await requireOperatorSession();
  const { workflowId } = await params;
  const result = await fetchWorkflowView(workflowId, session);
  if (!result.ok) redirectIfUnauthorized(result.status);
  return (
    <main>
      <p>
        <Link href="/admin/onboarding">← All workflows</Link>
      </p>
      <h1>Onboarding workflow</h1>
      {result.ok && (
        <p>
          <Link href={`/admin/onboarding/${encodeURIComponent(workflowId)}/github`}>
            Record the employee&apos;s GitHub username
          </Link>
        </p>
      )}
      {result.ok ? (
        <WorkflowView view={result.body} />
      ) : (
        <p role="alert">
          {result.status === 404
            ? "Workflow not found."
            : result.status === 401
              ? "Unauthorized."
              : "Could not load this workflow. Try again."}
        </p>
      )}
    </main>
  );
}
