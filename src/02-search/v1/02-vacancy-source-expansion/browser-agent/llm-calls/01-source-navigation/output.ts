export const outputDescription =
  "Exactly one safe scroll, continuation click, wait, or stop decision for the current frozen source-page observation.";

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "controlId", "completion", "reason"],
  properties: {
    action: {
      type: "string",
      enum: ["click", "scroll", "wait", "stop"],
    },
    controlId: { type: "string" },
    completion: {
      type: "string",
      enum: ["continue", "exhausted", "blocked"],
    },
    reason: { type: "string" },
  },
} as const;
