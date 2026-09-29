// M7D: pre-export scan of ServiceNow publish sources / an exported update-set XML. Pure; returns
// COUNTS per finding category (never the matched text), so its output can be printed safely.

export interface ExportFinding {
  category: string;
  count: number;
}

const PATTERNS: Array<[string, RegExp]> = [
  [
    "tunnel_url",
    /https?:\/\/[A-Za-z0-9.-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.(?:app|io|dev)|loca\.lt)/gi,
  ],
  [
    "authorization_header",
    /\bAuthorization\s*[:=]\s*(?:Basic|Bearer|SSWS)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  ],
  ["basic_or_bearer_token", /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{20,}/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["openai_key", /\bsk-[A-Za-z0-9_-]{20,}/g],
];

/** Record types that must never be part of an application export. */
const FORBIDDEN_TYPES: Array<[string, RegExp]> = [
  ["user_record", /^sys_user$|^sys_user_grmember$|^sys_user_group$/i],
  ["role_assignment", /^sys_user_has_role$/i],
  ["system_property", /^sys_properties$/i],
];

export function scanExportText(
  text: string,
  secretValues: ReadonlyArray<{ name: string; value: string }>,
): ExportFinding[] {
  const findings: ExportFinding[] = [];
  for (const { name, value } of secretValues) {
    if (value.length < 8) continue;
    const count = text.split(value).length - 1;
    if (count > 0) findings.push({ category: `secret_value:${name}`, count });
  }
  for (const [category, re] of PATTERNS) {
    const count = (text.match(re) ?? []).length;
    if (count > 0) findings.push({ category, count });
  }
  return findings;
}

/**
 * Classifies update-record names/types: forbidden record types (users, role assignments,
 * properties) and data rows of the application's table (a record named "<table>_<sys_id>").
 */
export function scanUpdateRecords(
  records: ReadonlyArray<{ name: string; type?: string }>,
  table: string,
): ExportFinding[] {
  const counts = new Map<string, number>();
  const bump = (c: string) => counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const r of records) {
    const recordTable = r.name.replace(/_[0-9a-f]{32}$/, "");
    for (const [category, re] of FORBIDDEN_TYPES) if (re.test(recordTable)) bump(category);
    if (recordTable === table) bump("data_row");
  }
  return [...counts].map(([category, count]) => ({ category, count }));
}

/**
 * The update records' OWN names in an exported XML. Each <sys_update_xml> embeds its record in a
 * <payload>, whose inner <name> fields (e.g. a dictionary entry's table name) are NOT record names:
 * payloads are stripped first, or table-name fields would be miscounted as data rows.
 */
export function exportedRecordNames(xml: string): string[] {
  return [...xml.matchAll(/<sys_update_xml\b[\s\S]*?<\/sys_update_xml>/g)].flatMap((m) => {
    const outer = m[0].replace(/<payload>[\s\S]*?<\/payload>/g, "");
    const name = /<name>([^<]*)<\/name>/.exec(outer)?.[1];
    return name ? [name] : [];
  });
}
