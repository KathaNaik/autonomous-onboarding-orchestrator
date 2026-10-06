import type { OfferLetterProposal } from "../offer-letter/schema.js";
import type { OfferLetterEvalCase } from "./offer-letter-dataset.js";

export interface OfferLetterEvalObservation {
  caseId: string;
  proposal: OfferLetterProposal | null;
  error: string | null;
  latencyMs: number;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** Objective scores only: exact expected fields, forbidden-content leaks, schema validity. */
export function scoreOfferLetterEval(
  cases: readonly OfferLetterEvalCase[],
  observations: readonly OfferLetterEvalObservation[],
) {
  let expectedFields = 0;
  let correctFields = 0;
  let leaks = 0;
  const perCase = cases.map((c) => {
    const o = observations.find((x) => x.caseId === c.id);
    const p = o?.proposal ?? null;
    const misses: string[] = [];
    for (const [k, v] of Object.entries(c.expect)) {
      expectedFields++;
      if (p && norm(p[k as keyof OfferLetterProposal]) === norm(v)) correctFields++;
      else misses.push(k);
    }
    const text = p ? JSON.stringify(p).toLowerCase() : "";
    const leaked = c.forbidden.filter((f) => text.includes(f.toLowerCase()));
    leaks += leaked.length;
    return {
      caseId: c.id,
      ok: !!p && misses.length === 0 && leaked.length === 0,
      misses,
      leaked,
      error: o?.error ?? null,
    };
  });
  const latencies = observations.map((o) => o.latencyMs).sort((a, b) => a - b);
  const pct = (q: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  return {
    cases: cases.length,
    schemaValidRate: observations.filter((o) => o.proposal).length / Math.max(1, cases.length),
    fieldAccuracy: correctFields / Math.max(1, expectedFields),
    forbiddenLeaks: leaks,
    casesPassed: perCase.filter((c) => c.ok).length,
    latencyMs: {
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)),
      p50: pct(0.5),
      p95: pct(0.95),
    },
    perCase,
  };
}
