import {
  OPERATOR_ID_HEADER,
  fetchGitHubIdentity,
  recordGitHubIdentity,
} from "@/lib/github-identity-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workflowId: string }> };

/** HR page → web → API proxy. Forwards only the operator's own credentials and the username. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { workflowId } = await params;
  const result = await fetchGitHubIdentity(workflowId, request.headers.get("authorization") ?? "");
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { workflowId } = await params;
  const body: unknown = await request.json().catch(() => null);
  const githubLogin =
    typeof body === "object" && body !== null && "githubLogin" in body
      ? (body as { githubLogin: unknown }).githubLogin
      : undefined;
  const result = await recordGitHubIdentity(
    workflowId,
    request.headers.get("authorization") ?? "",
    request.headers.get(OPERATOR_ID_HEADER) ?? "",
    githubLogin,
  );
  return Response.json(result.body, { status: result.status });
}
