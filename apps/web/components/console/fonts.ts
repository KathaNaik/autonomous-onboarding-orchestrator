import { JetBrains_Mono, Public_Sans } from "next/font/google";

/**
 * Public Sans (a civic, plain-spoken UI face) for everything people read; JetBrains Mono only
 * for identifiers, codes and durations. Self-hosted at build time by Next (no runtime request
 * to Google).
 */
export const uiSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-ui-sans",
  display: "swap",
});
export const uiMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-ui-mono",
  display: "swap",
});
