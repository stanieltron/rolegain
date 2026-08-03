export const outputDescription =
  "One pass/needs-repair verdict for the supplied job with concrete findings, repair instructions, flags, confidence, and rationale.";

export interface AssessmentVerificationOutput {
  jobId: string;
  verdict: "pass" | "needs_repair";
  findings: Array<{
    code: string;
    requirement: string;
    message: string;
  }>;
  repairInstructions: string[];
  inflationFlags?: string[];
  feasibilityFlags?: string[];
  statusConfidence?: number;
  decision?: "accepted" | "revised" | "rejected";
  rationale?: string;
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "jobId",
    "verdict",
    "findings",
    "repairInstructions",
    "inflationFlags",
    "feasibilityFlags",
    "statusConfidence",
    "decision",
    "rationale",
  ],
  properties: {
    jobId: { type: "string" },
    verdict: { type: "string", enum: ["pass", "needs_repair"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "requirement", "message"],
        properties: {
          code: { type: "string" },
          requirement: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    repairInstructions: { type: "array", items: { type: "string" } },
    inflationFlags: { type: "array", items: { type: "string" } },
    feasibilityFlags: { type: "array", items: { type: "string" } },
    statusConfidence: { type: "number", minimum: 0, maximum: 1 },
    decision: {
      type: "string",
      enum: ["accepted", "revised", "rejected"],
    },
    rationale: { type: "string" },
  },
} as const;
