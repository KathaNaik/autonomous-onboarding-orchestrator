import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeMenu } from "@/components/console/theme-menu";
import { THEME_KEY, THEME_SCRIPT, parseTheme } from "@/lib/theme";

/** Runs the pre-paint script against a fake document and storage. */
function runScript(stored: string | null | Error) {
  const attrs: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) => {
      if (stored instanceof Error) throw stored;
      return key === THEME_KEY ? stored : null;
    },
  };
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
  };
  new Function("localStorage", "document", THEME_SCRIPT)(localStorage, document);
  return attrs["data-theme"] ?? null;
}

describe("color theme", () => {
  it("only light and dark are saved choices; anything else follows the device", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    for (const v of [null, undefined, "", "system", "DARK", "<script>"]) {
      expect(parseTheme(v)).toBe("system");
    }
  });

  it("the pre-paint script applies a saved choice and never throws", () => {
    expect(runScript("dark")).toBe("dark");
    expect(runScript("light")).toBe("light");
    expect(runScript(null)).toBeNull(); // device
    expect(runScript('"><img src=x>')).toBeNull(); // never writes an unexpected value
    expect(runScript(new Error("storage blocked"))).toBeNull();
  });

  it("the menu renders Light, Dark and Device with Device selected by default", () => {
    const html = renderToStaticMarkup(<ThemeMenu />);
    expect(html).toContain('aria-label="Theme: Device"');
    for (const label of ["Light", "Dark", "Device"])
      expect(html).toContain(`<span>${label}</span>`);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)<span>Device<\/span>/);
    expect(html).not.toMatch(/<form|<input/);
  });
});
