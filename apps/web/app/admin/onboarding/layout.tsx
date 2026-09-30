import type { ReactNode } from "react";
import { currentOperatorSession } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";

/** Internal operator area (M9). Shows the signed-in operator and a logout control. */
export default async function OnboardingAdminLayout({ children }: { children: ReactNode }) {
  const session = await currentOperatorSession();
  return (
    <div
      style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: 16 }}
    >
      {session && (
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid #ddd",
            paddingBottom: 6,
          }}
        >
          <span>
            Onboarding operator dashboard · signed in as <strong>{session.operatorId}</strong>
          </span>
          <form method="post" action="/admin/onboarding/logout">
            <button type="submit">Log out</button>
          </form>
        </header>
      )}
      {children}
    </div>
  );
}
