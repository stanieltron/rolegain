export interface CvTailoringOutput {
  content: string;
  changeSummary: string[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "changeSummary"],
  properties: {
    content: { type: "string" },
    changeSummary: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export const outputDescription =
  "A complete Markdown CV plus a concise list of job-specific changes.";
