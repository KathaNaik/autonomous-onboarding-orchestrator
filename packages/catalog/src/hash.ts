import { createHash } from "node:crypto";
import type { CatalogDocument } from "./schema.js";

/** JSON with object keys sorted recursively, so the hash doesn't depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Content hash of a normalized catalog document (all resources, enabled or not). */
export function catalogHash(document: CatalogDocument): string {
  return `sha256:${createHash("sha256").update(canonicalJson(document)).digest("hex")}`;
}
