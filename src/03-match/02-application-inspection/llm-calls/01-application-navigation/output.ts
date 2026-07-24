export interface ApplicationNavigationDecision {
  action: "click" | "scroll" | "wait" | "stop";
  controlId: string;
  reason: string;
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "controlId", "reason"],
  properties: {
    action: {
      type: "string",
      enum: ["click", "scroll", "wait", "stop"],
    },
    controlId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

export const outputDescription =
  "One safe click, scroll, wait, or stop action for the current page observation.";
