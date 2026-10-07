import Link from "next/link";

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
    <main>
      <h1>Create an operator account</h1>
      <p>
        Act as an HR / onboarding operator: upload offer letters, review the details and start
        onboardings. Your email becomes your operator name in the audit trail.
      </p>
      {error && <p role="alert">{error}</p>}
      <form method="post" action="/admin/onboarding/signup/create">
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
          <label htmlFor="password">Password (12+ characters)</label>{" "}
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </p>
        <p>
          <label htmlFor="confirm">Confirm password</label>{" "}
          <input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </p>
        <button type="submit">Create account</button>
      </form>
      <p>
        Already have an account? <Link href="/admin/onboarding/login">Sign in</Link>
      </p>
    </main>
  );
}
