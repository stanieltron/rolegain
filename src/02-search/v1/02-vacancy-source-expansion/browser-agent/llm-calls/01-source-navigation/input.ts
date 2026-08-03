export interface SourceNavigationInput {
  sourceName: string;
  stepIndex: number;
  maxSteps: number;
  observation: unknown;
}

export function buildInput(input: SourceNavigationInput) {
  return `Vacancy source: ${input.sourceName}\nNavigation step ${input.stepIndex + 1} of ${input.maxSteps}. Reveal more concrete vacancy links, or stop with an evidence-based completion state.\n${JSON.stringify(
    input.observation,
    null,
    2,
  )}`;
}

export const inputDescription =
  "Frozen visible source-page text, controls, scroll metrics, and link-count progress.";
