import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swift · AOO",
  description:
    "Swift (AOO, Autonomous Onboarding Orchestrator) gets new hires ready to work: access recommended, approved, provisioned and planned automatically.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set before paint by THEME_SCRIPT, so the server markup differs on purpose.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
