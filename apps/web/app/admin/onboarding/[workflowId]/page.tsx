import { ConsoleShell } from "@/components/console/shell";
import { BackLink, Callout, PageHeader } from "@/components/console/ui";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { fetchWorkflowView } from "@/lib/onboarding-read-api";
import { WorkflowView } from "./workflow-view";

export const dynamic = "force-dynamic";

/** One onboarding workflow, explained. Server-rendered, read-only. */
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
    <ConsoleShell active="workflows" operatorId={session.operatorId}>
      {result.ok ? (
        <div>
          <BackLink href="/admin/onboarding" label="All workflows" />
          <WorkflowView view={result.body} />
        </div>
      ) : (
        <>
          <PageHeader
            title="Onboarding workflow"
            back={{ href: "/admin/onboarding", label: "All workflows" }}
          />
          <Callout
            tone={result.status === 404 ? "gray" : "red"}
            role="alert"
            title={
              result.status === 404
                ? "Workflow not found."
                : result.status === 401
                  ? "Unauthorized."
                  : "Could not load this workflow. Try again."
            }
          />
        </>
      )}
    </ConsoleShell>
  );
}
