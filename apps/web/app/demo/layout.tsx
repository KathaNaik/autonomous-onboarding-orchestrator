import Link from "next/link";
import type { ReactNode } from "react";
import { geistMono, geistSans } from "@/components/console/fonts";
import * as I from "@/components/console/icons";
import { ButtonLink, cx, styles as c } from "@/components/console/ui";
import styles from "./demo.module.css";

/** (M10) Public synthetic demo: read-only, no sign-in, no backend calls. Console look. */
export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <div className={cx(c.root, geistSans.variable, geistMono.variable, styles.page)}>
      <header className={styles.topbar}>
        <div className={cx(styles.container, styles.topbarInner)}>
          <Link href="/" className={c.brand}>
            <span className={c.brandMark}>
              <I.Logo />
            </span>
            Swift
          </Link>
          <nav aria-label="Site" className={styles.topLinks}>
            <Link href="/demo" className={cx(c.navLink, c.navLinkActive)}>
              Demo
            </Link>
            <ButtonLink href="/admin/onboarding/login" variant="secondary">
              Operator login
            </ButtonLink>
          </nav>
        </div>
      </header>
      <p className={styles.notice}>
        <span className={cx(styles.container, styles.noticeInner)} style={{ display: "block" }}>
          <strong>Public demo</strong> · synthetic people and data · read-only. Nothing here reads
          or changes a real onboarding.
        </span>
      </p>
      <div className={cx(styles.container, styles.main)}>{children}</div>
      <footer className={styles.footer}>
        <div className={styles.container}>
          Swift · AOO. Demo data is bundled with the site; the real console uses sandbox accounts.
        </div>
      </footer>
    </div>
  );
}
