import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

/**
 * Operator area. Each page renders its own frame (ConsoleShell or AuthShell from
 * components/console), so the active navigation item is known without client JavaScript.
 */
export default function OnboardingAdminLayout({ children }: { children: ReactNode }) {
  return children;
}
