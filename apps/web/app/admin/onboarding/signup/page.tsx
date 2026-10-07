import Link from "next/link";
import { AuthShell } from "@/components/console/shell";
import { Button, Callout, Field, styles as s } from "@/components/console/ui";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  INVALID_PAYLOAD:
    "Use an email made of letters, digits, dots, dashes or underscores (up to 64 characters) and a password of 12 to 128 characters.",
  ACCOUNT_UNAVAILABLE:
    "An account can't be created for this email. If you already have one, sign in instead.",
  SIGNUP_LIMIT_REACHED: "No more accounts can be created today. Try again tomorrow.",
  PASSWORD_MISMATCH: "The two passwords don't match.",
  unavailable: "Account creation is unavailable right now. Try again shortly.",
};

/**
 * (M12) Create an operator account: a plain HTML form (no client JavaScript) posting to the
 * server handler. User decision: anyone may sign up, and every account is a full operator.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? MESSAGES[params.error] : undefined;
  return (
    <AuthShell
      title="Create an operator account"
      description="Upload offer letters, review the details and start onboardings. Your email becomes your operator name in the audit trail."
      footer={
        <>
          Already have an account? <Link href="/admin/onboarding/login">Sign in</Link>
        </>
      }
    >
      {error && <Callout tone="red" title={error} role="alert" />}
      <form
        method="post"
        action="/admin/onboarding/signup/create"
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
        <Field label="Password" htmlFor="password" hint="12 to 128 characters.">
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            className={s.input}
          />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            className={s.input}
          />
        </Field>
        <Button block>Create account</Button>
      </form>
    </AuthShell>
  );
}
