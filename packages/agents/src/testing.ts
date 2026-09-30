import type { ModelProvider, ModelRequest, ModelResponse } from "./providers/types.js";

/** One scripted provider step: a response, an error to throw, or a function of the request. */
export type ScriptedStep =
  | ModelResponse
  | Error
  | ((request: ModelRequest, signal: AbortSignal) => ModelResponse | Promise<ModelResponse>);

export interface ScriptedModelProvider extends ModelProvider {
  /** Every request received, in order. */
  readonly calls: ModelRequest[];
}

/**
 * Test double: returns the scripted steps in order (the last step repeats). Never makes a
 * network call. For tests and deterministic tooling only, never for reported live results.
 */
export function createScriptedModelProvider(
  steps: readonly ScriptedStep[],
  identity: { model?: string; configId?: string } = {},
): ScriptedModelProvider {
  const calls: ModelRequest[] = [];
  const model = identity.model ?? "scripted-test-model";
  return {
    provider: "scripted",
    model,
    configId: identity.configId ?? `scripted/${model}`,
    calls,
    async generate(request, { signal }) {
      calls.push(request);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("scripted provider has no steps");
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(request, signal);
      return step;
    },
  };
}

/** A structured output with the given recommendations (confidence 0.9, reason filled in). */
export function outputOf(
  ...items: (string | { resourceId: string; reasonCode?: string; confidence?: number })[]
): ModelResponse {
  return {
    output: {
      recommendations: items.map((item) => {
        const r = typeof item === "string" ? { resourceId: item } : item;
        return {
          resourceId: r.resourceId,
          reasonCode: r.reasonCode ?? "ROLE_BASELINE",
          reason: `Needed for the role (${r.resourceId}).`,
          confidence: r.confidence ?? 0.9,
        };
      }),
    },
    usage: { inputTokens: 1000, outputTokens: 100 },
  };
}

/** (M8) A structured onboarding plan output: three generic tasks plus one per given resource. */
export function planOutputOf(
  resourceIds: readonly string[] = [],
  overrides: { summary?: string; extraTasks?: readonly Record<string, unknown>[] } = {},
): ModelResponse {
  const generic = [
    {
      phase: "DAY_ONE",
      category: "SECURITY",
      title: "Set up multi-factor authentication",
      instruction: "Enable multi-factor authentication on every account you were given.",
      resourceIds: [],
    },
    {
      phase: "FIRST_WEEK",
      category: "TEAM_ONBOARDING",
      title: "Meet your team",
      instruction: "Introduce yourself to your team and learn how it plans and reviews work.",
      resourceIds: [],
    },
    {
      phase: "FIRST_30_DAYS",
      category: "FIRST_DELIVERABLE",
      title: "Plan a first deliverable",
      instruction: "Agree on a small first piece of work and deliver it.",
      resourceIds: [],
    },
  ];
  return {
    output: {
      summary: overrides.summary ?? "A practical onboarding checklist for your first month.",
      tasks: [
        ...generic,
        ...resourceIds.map((id) => ({
          phase: "DAY_ONE",
          category: "ACCOUNT_SETUP",
          title: `Sign in to ${id}`,
          instruction: `Sign in to ${id} and confirm you can use it.`,
          resourceIds: [id],
        })),
        ...(overrides.extraTasks ?? []),
      ],
    },
    usage: { inputTokens: 1500, outputTokens: 400 },
    model: "scripted-test-model",
    responseId: "resp_scripted",
  };
}
