import Link from "next/link";

export const dynamic = "force-static";

/** (M10) Public landing page. */
export default function HomePage() {
  return (
    <main style={page}>
      <h1>Autonomous Onboarding Orchestrator</h1>
      <p style={{ fontSize: 18 }}>
        Event-driven employee onboarding: a signed HRIS event starts a durable workflow; an AI agent
        recommends access from a versioned catalog; a deterministic policy engine authorizes each
        resource; humans approve and fulfill in ServiceNow; adapters provision Okta and GitHub; a
        second agent writes the onboarding checklist.
      </p>
      <blockquote style={quote}>
        Agents recommend. Policies authorize. Adapters execute. The orchestrator owns state.
      </blockquote>
      <p style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Link href="/demo" style={primary}>
          View Demo
        </Link>
        <Link href="/admin/onboarding/login" style={secondary}>
          Operator Login
        </Link>
      </p>
      <h2>How it runs</h2>
      <ul>
        <li>PostgreSQL is the system of record: workflow state, transactional outbox, audit.</li>
        <li>
          A bounded worker drains the outbox when woken by a signed scheduler (business hours); work
          that arrives off-hours waits durably and resumes on the next run.
        </li>
        <li>Every external write is idempotent, reconciled and read back before it counts.</li>
      </ul>
      <p>
        <small>The public demo uses synthetic data only. The operator dashboard is internal.</small>
      </p>
    </main>
  );
}

const page = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 820,
  margin: "0 auto",
  padding: 16,
  lineHeight: 1.5,
} as const;
const quote = { borderLeft: "4px solid #8ab0f0", margin: "16px 0", padding: "4px 12px" } as const;
const button = { padding: "10px 16px", borderRadius: 6, textDecoration: "none" } as const;
const primary = { ...button, background: "#1a4a9c", color: "#fff" } as const;
const secondary = { ...button, border: "1px solid #1a4a9c", color: "#1a4a9c" } as const;
