import Link from "next/link";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  unauthorized:
    "Sign-in failed. Check your email and password. After 5 failed attempts, wait 15 minutes.",
  unavailable: "Sign-in is unavailable right now. Try again shortly.",
  expired: "Your session has ended. Sign in again.",
};

/**
 * Dashboard sign-in. A plain HTML form that posts directly to the server-side session handler:
 * the password is never held in React state or client-side JavaScript. (M12) Operators sign in
 * with their own account (email + password); anyone can create one.
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
      <p>Sign in as an HR / onboarding operator to run onboardings.</p>
      {error && <p role="alert">{error}</p>}
      {params.loggedOut === "1" && <p role="status">Signed out.</p>}
      {params.loggedOut === "unconfirmed" && (
        <p role="status">
          Signed out in this browser. The server could not confirm the revocation; the session
          expires on its own within 30 minutes.
        </p>
      )}
      <form method="post" action="/admin/onboarding/session">
        <p>
          <label htmlFor="email">Email</label>{" "}
          <input
            id="email"
            name="email"
            type="email"
            required
            maxLength={64}
            autoComplete="username"
          />
        </p>
        <p>
          <label htmlFor="password">Password</label>{" "}
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="current-password"
          />
        </p>
        <button type="submit">Sign in</button>
      </form>
      <p>
        New here? <Link href="/admin/onboarding/signup">Create an operator account</Link>
      </p>
    </main>
  );
}
