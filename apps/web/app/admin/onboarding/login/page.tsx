import Link from "next/link";
import { AuthShell } from "@/components/console/shell";
import { Button, Callout, Field, styles as s } from "@/components/console/ui";

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
    <AuthShell
      title="Sign in"
      description="Run onboardings as an HR or onboarding operator."
      footer={
        <>
          New here? <Link href="/admin/onboarding/signup">Create an operator account</Link>
        </>
      }
    >
      {error && <Callout tone="red" title={error} role="alert" />}
      {params.loggedOut === "1" && <Callout tone="gray" title="Signed out." role="status" />}
      {params.loggedOut === "unconfirmed" && (
        <Callout tone="amber" title="Signed out in this browser." role="status">
          The server could not confirm the revocation; the session expires on its own within 30
          minutes.
        </Callout>
      )}
      <form
        method="post"
        action="/admin/onboarding/session"
        className={s.stackMd}
        style={{ gap: 16 }}
      >
        <Field label="Email" htmlFor="email">
          <input
            id="email"
            name="email"
            type="email"
            required
            maxLength={64}
            autoComplete="username"
            className={s.input}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="current-password"
            className={s.input}
          />
        </Field>
        <Button block>Sign in</Button>
      </form>
    </AuthShell>
  );
}
