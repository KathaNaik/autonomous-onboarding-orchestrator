import Link from "next/link";
import type { ReactNode } from "react";
import { geistMono, geistSans } from "./fonts";
import { Logo } from "./icons";
import { cx, styles as s } from "./ui";
import { ThemeMenu } from "./theme-menu";

export type NavKey = "workflows" | "new";

const NAV: { key: NavKey | "demo"; href: string; label: string }[] = [
  { key: "workflows", href: "/admin/onboarding", label: "Workflows" },
  { key: "new", href: "/admin/onboarding/new", label: "New onboarding" },
  { key: "demo", href: "/demo", label: "Demo" },
];

const fontVars = `${geistSans.variable} ${geistMono.variable}`;

function LogoutForm() {
  return (
    <form method="post" action="/admin/onboarding/logout">
      <button type="submit" className={cx(s.button, s.ghost)}>
        Log out
      </button>
    </form>
  );
}

/**
 * The authenticated console frame: product identity, navigation, the signed-in operator and
 * Log out. Server-rendered; the mobile menu is a native <details> disclosure (no JavaScript).
 */
export function ConsoleShell({
  active,
  operatorId,
  children,
}: {
  active: NavKey;
  /** The signed-in operator (the page has already verified the session). */
  operatorId: string | null;
  children: ReactNode;
}) {
  const session = operatorId ? { operatorId } : null;
  const links = NAV.map((n) => (
    <Link
      key={n.key}
      href={n.href}
      className={cx(s.navLink, n.key === active && s.navLinkActive)}
      aria-current={n.key === active ? "page" : undefined}
    >
      {n.label}
    </Link>
  ));
  return (
    <div className={cx(s.root, fontVars)}>
      <a href="#main" className={s.skip}>
        Skip to content
      </a>
      <header className={s.topbar}>
        <div className={s.topbarInner}>
          <Link href="/admin/onboarding" className={s.brand}>
            <span className={s.brandMark}>
              <Logo />
            </span>
            Swift
          </Link>
          <nav aria-label="Primary" className={s.nav}>
            {links}
          </nav>
          <ThemeMenu />
          {session && (
            <div className={s.account}>
              <span className={s.accountEmail} title={session.operatorId}>
                {session.operatorId}
              </span>
              <LogoutForm />
            </div>
          )}
          <details className={s.menu}>
            <summary>Menu</summary>
            <div className={s.menuPanel}>
              <nav aria-label="Primary (mobile)" className={s.stack}>
                {links}
              </nav>
              {session && (
                <div className={s.menuAccount}>
                  <span>{session.operatorId}</span>
                  <LogoutForm />
                </div>
              )}
            </div>
          </details>
        </div>
      </header>
      <main id="main" className={s.main}>
        {children}
      </main>
    </div>
  );
}

/** Centered card for sign-in and account creation. */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={cx(s.root, fontVars)} style={{ position: "relative" }}>
      <div style={{ position: "absolute", top: 16, right: 16 }}>
        <ThemeMenu />
      </div>
      <main className={s.authPage}>
        <div style={{ width: "100%", display: "grid", justifyItems: "center" }}>
          <div className={s.authCard}>
            <div className={s.authHead}>
              <span className={s.authBrand}>
                <span className={s.brand}>
                  <span className={s.brandMark}>
                    <Logo size={32} />
                  </span>
                  Swift
                </span>
                <span className={s.authProduct}>Operator dashboard</span>
              </span>
              <h1 className={s.authTitle}>{title}</h1>
              <p className={s.muted}>{description}</p>
            </div>
            {children}
            {footer && <p className={s.authFoot}>{footer}</p>}
          </div>
          <p className={s.authNote}>
            A portfolio demonstration with synthetic hires. Integrations run against sandbox
            accounts.
          </p>
        </div>
      </main>
    </div>
  );
}
