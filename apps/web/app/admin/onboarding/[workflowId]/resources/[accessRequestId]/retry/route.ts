import { handleOperatorAction } from "@/lib/operator-action-route";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workflowId: string; accessRequestId: string }> };

/** M13: "Retry" on the workflow page (see lib/operator-action-route.ts). */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { workflowId, accessRequestId } = await params;
  return handleOperatorAction(request, workflowId, accessRequestId, "retry");
}
