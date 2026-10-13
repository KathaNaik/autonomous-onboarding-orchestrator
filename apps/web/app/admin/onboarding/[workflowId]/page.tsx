import { ConsoleShell } from "@/components/console/shell";
import { BackLink, Callout, PageHeader } from "@/components/console/ui";
import { redirectIfUnauthorized, requireOperatorSession } from "@/lib/dashboard-auth";
import { MANUAL_RESULT_MESSAGES, detailTab } from "@/lib/console-model";
import { fetchWorkflowView } from "@/lib/onboarding-read-api";
import { WorkflowView } from "./workflow-view";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * One onboarding workflow for HR/IT. Server-rendered; `?tab=` picks a section (plain links, no
 * client JavaScript) and `?result=` shows the outcome of "Mark as done" (fixed codes only).
 */
export default async function WorkflowDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  const { workflowId } = await params;
  const query = (await searchParams) ?? {};
  const tab = detailTab(first(query.tab));
  const outcome = first(query.result);
  const result = await fetchWorkflowView(workflowId, session);
  if (!result.ok) redirectIfUnauthorized(result.status);
  return (
    <ConsoleShell active="workflows" operatorId={session.operatorId}>
      {result.ok ? (
        <div>
          <BackLink href="/admin/onboarding" label="All workflows" />
          <WorkflowView
            view={result.body}
            tab={tab}
            result={outcome && outcome in MANUAL_RESULT_MESSAGES ? outcome : null}
          />
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
