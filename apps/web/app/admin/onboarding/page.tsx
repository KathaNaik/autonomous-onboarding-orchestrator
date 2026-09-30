import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOperatorSession } from "@/lib/dashboard-auth";
import { WORKFLOW_STATE_OPTIONS, humanize } from "@/lib/dashboard-model";
import { fetchWorkflowList, listQuery } from "@/lib/onboarding-read-api";
import { WorkflowTable } from "./workflow-table";

export const dynamic = "force-dynamic";

/** (M9) Internal operator dashboard: recent onboarding workflows. Server-rendered, read-only. */
export default async function OnboardingDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOperatorSession();
  const params = await searchParams;
  const lookup = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookup)) {
    redirect(`/admin/onboarding/${lookup.toLowerCase()}`);
  }
  const query = listQuery({ limit: "25", ...params });
  const state = query.get("state") ?? "";
  const result = await fetchWorkflowList(query, session.operatorId);
  const next =
    result.ok && result.body.nextCursor
      ? `/admin/onboarding?${new URLSearchParams({ ...(state && { state }), cursor: result.body.nextCursor })}`
      : null;
  return (
    <main>
      <h1>Onboarding workflows</h1>
      <p>Internal operator view. Read-only: nothing on this page changes a workflow.</p>
      <form method="get" action="/admin/onboarding" style={{ margin: "8px 0" }}>
        <label htmlFor="state">State</label>{" "}
        <select id="state" name="state" defaultValue={state}>
          <option value="">All states</option>
          {WORKFLOW_STATE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>{" "}
        <label htmlFor="workflowId">Workflow id</label>{" "}
        <input id="workflowId" name="workflowId" size={38} /> <button type="submit">Apply</button>
      </form>
      {lookup && <p role="alert">Not a workflow id.</p>}
      {!result.ok ? (
        <p role="alert">
          {result.status === 401 ? "Unauthorized." : "Could not load workflows. Try again."}
        </p>
      ) : (
        <>
          <WorkflowTable items={result.body.items} />
          <p>
            {query.get("cursor") && (
              <Link href={`/admin/onboarding${state ? `?state=${state}` : ""}`}>First page</Link>
            )}{" "}
            {next && <Link href={next}>Next page</Link>}
          </p>
        </>
      )}
    </main>
  );
}
