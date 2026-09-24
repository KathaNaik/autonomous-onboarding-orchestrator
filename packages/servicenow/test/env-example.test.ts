import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for the committed template: ServiceNow credentials must only ever live in the
// git-ignored .env. (A real password was once pasted into .env.example during M4A setup.)
const example = readFileSync(
  fileURLToPath(new URL("../../../.env.example", import.meta.url)),
  "utf8",
);

describe(".env.example", () => {
  it("contains no ServiceNow password values", () => {
    const passwords = example
      .split("\n")
      .map((l) => l.replace(/^#\s*/, ""))
      .filter((l) => /^SERVICENOW_[A-Z_]*PASSWORD=/.test(l))
      .map((l) => l.slice(l.indexOf("=") + 1).trim());
    expect(passwords.length).toBeGreaterThan(0);
    for (const value of passwords) expect(["", "''", '""']).toContain(value);
  });

  it("points at a placeholder instance, not a real one", () => {
    expect(example).toMatch(/^SERVICENOW_INSTANCE_URL=https:\/\/dev000000\.service-now\.com$/m);
  });
});
