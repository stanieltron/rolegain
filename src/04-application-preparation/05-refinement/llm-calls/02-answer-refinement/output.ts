import type { ApplicationAnswerRefinement } from "../../../types.js";

export type ApplicationAnswerRefinementOutput = ApplicationAnswerRefinement;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["value", "evidenceBasis"],
  properties: {
    value: { type: "string" },
    evidenceBasis: { type: "string" },
  },
} as const;

export const outputDescription =
  "Complete revised answer and its evidence basis.";
