import type { ApplicationDraftVerification } from "../../../types.js";

export interface ApplicationVerificationOutput {
  verifications: ApplicationDraftVerification[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verifications"],
  properties: {
    verifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "applicationId",
          "verdict",
          "findings",
          "repairInstructions",
        ],
        properties: {
          applicationId: { type: "string" },
          verdict: { type: "string", enum: ["pass", "needs_repair"] },
          findings: { type: "array", items: { type: "string" } },
          repairInstructions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export const outputDescription =
  "Pass or repair verdict with concrete findings per application.";
