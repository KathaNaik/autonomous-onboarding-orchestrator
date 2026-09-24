import type { ResourceCatalog } from "@aoo/catalog";
import { RoleAccessModelOutputSchema } from "../role-access/schema.js";
import type { RoleAccessEvalCase } from "./dataset.js";

/** One evaluated case: the raw model output (if any) and how the agent run ended. */
export interface RoleAccessEvalObservation {
  readonly case: RoleAccessEvalCase;
  /** The last raw structured output the provider returned, before validation. */
  readonly rawOutput: unknown;
  /** "ok", or the agent error category. */
  readonly outcome: string;
  readonly latencyMs: number;
  readonly usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface RoleAccessEvalCaseReport {
  readonly id: string;
  readonly outcome: string;
  readonly schemaValid: boolean;
  readonly catalogValid: boolean;
  readonly recommended: readonly string[];
  readonly missingRequired: readonly string[];
  readonly excludedViolations: readonly string[];
  readonly hallucinated: readonly string[];
  readonly duplicates: readonly string[];
  readonly latencyMs: number;
}

export interface RoleAccessEvalReport {
  readonly totalCases: number;
  readonly schemaValidRate: number;
  readonly catalogValidRate: number;
  /** Required resources recommended / required resources, over all cases. */
  readonly mustIncludeRecall: number;
  /** Cases recommending any must-exclude resource / cases. */
  readonly mustExcludeViolationRate: number;
  readonly hallucinatedResourceCount: number;
  /** Ids in the catalog but disabled. */
  readonly disabledResourceCount: number;
  readonly duplicateResourceCount: number;
  /** Cases with a valid, empty recommendation list / cases. */
  readonly emptyResultRate: number;
  readonly latencyMs: { readonly average: number; readonly p50: number; readonly p95: number };
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly cases: readonly RoleAccessEvalCaseReport[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Pure scoring of evaluation observations against the catalog the cases were run with. */
export function scoreRoleAccessEval(
  observations: readonly RoleAccessEvalObservation[],
  catalog: ResourceCatalog,
): RoleAccessEvalReport {
  let required = 0;
  let requiredHit = 0;
  let disabledCount = 0;
  const cases = observations.map((o): RoleAccessEvalCaseReport => {
    const parsed = RoleAccessModelOutputSchema.safeParse(o.rawOutput);
    const raw = (o.rawOutput as { recommendations?: { resourceId?: unknown }[] } | undefined)
      ?.recommendations;
    const ids = Array.isArray(raw)
      ? raw.map((r) => r?.resourceId).filter((id): id is string => typeof id === "string")
      : [];
    const check = catalog.validateResourceIds(ids);
    disabledCount += check.disabled.length;
    const recommended = [...new Set(ids)].sort();
    required += o.case.mustInclude.length;
    const missingRequired = o.case.mustInclude.filter((id) => !recommended.includes(id));
    requiredHit += o.case.mustInclude.length - missingRequired.length;
    return {
      id: o.case.id,
      outcome: o.outcome,
      schemaValid: parsed.success,
      catalogValid: parsed.success && check.valid,
      recommended,
      missingRequired,
      excludedViolations: o.case.mustExclude.filter((id) => recommended.includes(id)),
      hallucinated: check.unknown,
      duplicates: check.duplicates,
      latencyMs: o.latencyMs,
    };
  });
  const n = cases.length || 1;
  const latencies = observations.map((o) => o.latencyMs).sort((a, b) => a - b);
  const withUsage = observations.filter((o) => o.usage);
  return {
    totalCases: cases.length,
    schemaValidRate: round(cases.filter((c) => c.schemaValid).length / n),
    catalogValidRate: round(cases.filter((c) => c.catalogValid).length / n),
    mustIncludeRecall: required === 0 ? 1 : round(requiredHit / required),
    mustExcludeViolationRate: round(
      cases.filter((c) => c.excludedViolations.length > 0).length / n,
    ),
    hallucinatedResourceCount: cases.reduce((sum, c) => sum + c.hallucinated.length, 0),
    disabledResourceCount: disabledCount,
    duplicateResourceCount: cases.reduce((sum, c) => sum + c.duplicates.length, 0),
    emptyResultRate: round(
      cases.filter((c) => c.catalogValid && c.recommended.length === 0).length / n,
    ),
    latencyMs: {
      average: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    tokens: withUsage.length
      ? {
          input: withUsage.reduce((s, o) => s + o.usage!.inputTokens, 0),
          output: withUsage.reduce((s, o) => s + o.usage!.outputTokens, 0),
        }
      : null,
    cases,
  };
}
