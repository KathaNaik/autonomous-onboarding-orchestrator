import type { ReactNode } from "react";

/** Inline 16px stroke icons (no external assets). Decorative: hidden from assistive tech. */
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Check = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);
export const Clock = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Svg>
);
export const Spinner = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />
  </Svg>
);
export const Cross = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);
export const Dot = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const Alert = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 2.5l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.3v.2" />
  </Svg>
);
export const Info = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5v3.5M8 5.2v.2" />
  </Svg>
);
export const Plus = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const ArrowLeft = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12.5 8h-9M7 4.5L3.5 8 7 11.5" />
  </Svg>
);
export const Search = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </Svg>
);
export const FileDoc = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 1.5h5l3 3v10H4z" />
    <path d="M9 1.5v3h3M6 9h4M6 11.5h4" />
  </Svg>
);
export const Sparkle = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6" />
  </Svg>
);
export const Shield = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z" />
    <path d="M5.8 8l1.6 1.6L10.5 6.5" />
  </Svg>
);
export const Gear = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
  </Svg>
);
export const Person = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
  </Svg>
);
export const Lock = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);
/** Swift's mark: an "S" drawn as a workflow path with step dots, ending in a check (done). */
export const LOGO_PATH = "M3 30H22A6 6 0 0 0 22 18H17A6 6 0 0 1 17 6H24";
export const LOGO_CHECK = "M27.5 9.5L31 13L37.5 5";
export const Logo = ({ size = 26, check = "#2563eb" }: { size?: number; check?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 40 40"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <path d={LOGO_PATH} stroke="#2563eb" strokeWidth="4" strokeLinejoin="round" />
    <circle cx="11" cy="30" r="3.5" fill="#2563eb" />
    <circle cx="24" cy="6" r="3.5" fill="#2563eb" />
    <path d={LOGO_CHECK} stroke={check} strokeWidth="4" strokeLinecap="square" />
  </svg>
);
export const Sun = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Svg>
);
export const Moon = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
  </Svg>
);
export const Monitor = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="8.5" rx="1.5" />
    <path d="M5.5 14h5M8 11v3" />
  </Svg>
);
export const ChevronDown = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Svg>
);
