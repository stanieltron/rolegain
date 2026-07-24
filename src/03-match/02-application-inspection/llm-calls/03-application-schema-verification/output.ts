export interface ApplicationSchemaVerificationOutput {
  issues: string[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export const outputDescription =
  "Concrete structural or semantic mapping defects.";
