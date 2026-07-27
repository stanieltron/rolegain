import type { ReasoningEffort } from "../../../src/codex-runtime/llm-call-config.js";

export interface ModelEffortPair {
  model: string;
  effort: ReasoningEffort;
}

export const DEFAULT_MODEL_EFFORT_MATRIX: ModelEffortPair[] = [
  { model: "gpt-5.6-sol", effort: "low" },
  { model: "gpt-5.6-sol", effort: "medium" },
  { model: "gpt-5.6-sol", effort: "high" },
  { model: "gpt-5.6-terra", effort: "low" },
  { model: "gpt-5.6-terra", effort: "medium" },
  { model: "gpt-5.6-terra", effort: "high" },
  { model: "gpt-5.6-luna", effort: "low" },
  { model: "gpt-5.6-luna", effort: "medium" },
  { model: "gpt-5.6-luna", effort: "high" },
  { model: "gpt-5.5", effort: "low" },
  { model: "gpt-5.5", effort: "medium" },
  { model: "gpt-5.5", effort: "high" },
  { model: "gpt-5.4", effort: "medium" },
  { model: "gpt-5.4", effort: "high" },
  { model: "gpt-5.4-mini", effort: "medium" },
  { model: "gpt-5.4-mini", effort: "high" },
];

export function modelEffortId(pair: ModelEffortPair) {
  return `${pair.model}-${pair.effort}`;
}

export function parseModelEffortPairs(value: string): ModelEffortPair[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [model, effort, extra] = item.split(":");
      if (!model || !effort || extra)
        throw new Error(
          `Expected model-effort pair as model:effort, received ${item}`,
        );
      if (!isReasoningEffort(effort))
        throw new Error(
          `Unsupported reasoning effort ${effort}; use low, medium, or high`,
        );
      return { model, effort };
    });
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}
