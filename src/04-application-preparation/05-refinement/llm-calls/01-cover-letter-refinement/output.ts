import type { CoverLetterRefinement } from "../../../types.js";

export type CoverLetterRefinementOutput = Omit<
  CoverLetterRefinement,
  "threadId"
>;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["coverLetter", "assistantMessage"],
  properties: {
    coverLetter: { type: "string" },
    assistantMessage: { type: "string" },
  },
} as const;

export const outputDescription =
  "Complete revised cover letter and concise assistant response.";
