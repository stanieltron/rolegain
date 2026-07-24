import type { ApplicationContentDraft } from "../../../types.js";

export interface ApplicationDraftOutput {
  drafts: ApplicationContentDraft[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["drafts"],
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["applicationId", "coverLetter", "answers"],
        properties: {
          applicationId: { type: "string" },
          coverLetter: { type: "string" },
          answers: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["fieldId", "value", "evidenceBasis"],
              properties: {
                fieldId: { type: "string" },
                value: { type: "string" },
                evidenceBasis: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const outputDescription =
  "One cover letter and grounded answer set per application id.";
