import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Swift · AOO",
  description:
    "Swift (AOO, Autonomous Onboarding Orchestrator) gets new hires ready to work: access recommended, approved, provisioned and planned automatically.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
