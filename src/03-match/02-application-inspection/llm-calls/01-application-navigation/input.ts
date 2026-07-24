export function buildInput(input: {
  step: number;
  maximumSteps: number;
  observation: unknown;
}) {
  return `Navigation step ${input.step + 1} of ${input.maximumSteps}.\n${JSON.stringify(
    input.observation,
    null,
    2,
  )}`;
}

export const inputDescription =
  "Visible page text and bounded interactive control descriptions.";
