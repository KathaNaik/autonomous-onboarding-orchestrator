"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { THEMES, THEME_KEY, THEME_LABELS, parseTheme, type Theme } from "@/lib/theme";
import * as I from "./icons";
import s from "./console.module.css";

const ICONS: Record<Theme, () => ReactNode> = {
  light: () => <I.Sun size={16} />,
  dark: () => <I.Moon size={16} />,
  system: () => <I.Monitor size={16} />,
};

function apply(theme: Theme) {
  const html = document.documentElement;
  if (theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", theme);
}

/**
 * Light / Dark / Device. A native <details> dropdown; the choice is kept per browser in
 * localStorage (Device = no saved value, follow the operating system). No server state.
 */
export function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>("system");
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    try {
      setTheme(parseTheme(localStorage.getItem(THEME_KEY)));
    } catch {
      // Storage unavailable (private mode, blocked): follow the device.
    }
    const close = (focusSummary: boolean) => {
      const details = ref.current;
      if (!details?.open) return;
      details.open = false;
      if (focusSummary) details.querySelector("summary")?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const choose = (next: Theme) => {
    setTheme(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not saved; the choice still applies to this page.
    }
    if (ref.current) ref.current.open = false;
    ref.current?.querySelector("summary")?.focus();
  };

  return (
    <details ref={ref} className={s.themeMenu}>
      <summary className={s.themeButton} aria-label={`Theme: ${THEME_LABELS[theme]}`}>
        {ICONS[theme]()}
        <span className={s.themeCurrent}>{THEME_LABELS[theme]}</span>
        <I.ChevronDown size={14} />
      </summary>
      <div className={s.themePanel} role="group" aria-label="Color theme">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            className={s.themeOption}
            aria-pressed={t === theme}
            onClick={() => choose(t)}
          >
            {ICONS[t]()}
            <span>{THEME_LABELS[t]}</span>
            {t === theme && (
              <span className={s.themeTick}>
                <I.Check size={14} />
              </span>
            )}
          </button>
        ))}
      </div>
    </details>
  );
}
