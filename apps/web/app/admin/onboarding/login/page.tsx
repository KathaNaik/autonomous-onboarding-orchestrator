export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  unauthorized: "Unauthorized. Check the operator token and operator id.",
  unavailable: "The operator dashboard is not configured on this server.",
  expired: "Your session has ended. Sign in again.",
};

/**
 * (M9) Dashboard login. A plain HTML form that posts directly to the server-side session handler:
 * the token is never held in React state or client-side JavaScript. Internal operators only.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? MESSAGES[params.error] : undefined;
  return (
    <main>
      <h1>Operator sign-in</h1>
      <p>Internal onboarding operators only.</p>
      {error && <p role="alert">{error}</p>}
      {params.loggedOut === "1" && <p role="status">Signed out.</p>}
      {params.loggedOut === "unconfirmed" && (
        <p role="status">
          Signed out in this browser. The server could not confirm the revocation; the session
          expires on its own within 30 minutes.
        </p>
      )}
      <form method="post" action="/admin/onboarding/session" autoComplete="off">
        <p>
          <label htmlFor="token">Operator token</label>{" "}
          <input id="token" name="token" type="password" required autoComplete="off" />
        </p>
        <p>
          <label htmlFor="operatorId">Operator id</label>{" "}
          <input
            id="operatorId"
            name="operatorId"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._@-]{0,63}"
          />
        </p>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
