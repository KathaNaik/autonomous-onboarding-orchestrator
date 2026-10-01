import Link from "next/link";
import type { ReactNode } from "react";

/** (M10) Public synthetic demo: read-only, no sign-in, no backend calls. */
export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <div style={shell}>
      <header style={bar}>
        <Link href="/">Autonomous Onboarding Orchestrator</Link>
        <span>
          <strong>Public demo</strong> · synthetic data · read-only
        </span>
      </header>
      {children}
    </div>
  );
}

const shell = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 1100,
  margin: "0 auto",
  padding: 16,
  lineHeight: 1.45,
} as const;
const bar = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  gap: 8,
  borderBottom: "1px solid #ddd",
  paddingBottom: 8,
  marginBottom: 12,
} as const;
