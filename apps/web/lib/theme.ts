/**
 * Color theme: light, dark, or follow the device. A per-browser preference kept in localStorage
 * (no saved value = follow the device). Applied as `data-theme` on <html>; the console tokens in
 * components/console/console.module.css switch on it.
 */
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_KEY = "swift-theme";

export const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "Device",
};

export const parseTheme = (value: unknown): Theme =>
  value === "light" || value === "dark" ? value : "system";

/** Runs in <head> before first paint, so a saved choice never flashes the other theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
