export interface CoverageFinding {
  findingId?: string;
  operation?: "add" | "adjust";
  target?:
    | "profileFacts"
    | "profileEvidence"
    | "insights"
    | "detailedNotes"
    | "claims"
    | "unknowns"
    | "prohibitedInferences";
  field?: string;
  severity?: "blocking" | "warning";
  quote: string;
  reason: string;
  category:
    | "profile"
    | "experience"
    | "skill"
    | "education"
    | "date"
    | "metric"
    | "other";
}

export interface ChunkCoverageVerification {
  complete: boolean;
  missingEvidence: CoverageFinding[];
  unsupportedExtractions: string[];
  summary: string;
}

const string = { type: "string" };

export const outputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "complete",
    "missingEvidence",
    "unsupportedExtractions",
    "summary",
  ],
  properties: {
    complete: { type: "boolean" },
    missingEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "findingId",
          "operation",
          "target",
          "field",
          "severity",
          "quote",
          "reason",
          "category",
        ],
        properties: {
          findingId: string,
          operation: { type: "string", enum: ["add", "adjust"] },
          target: {
            type: "string",
            enum: [
              "profileFacts",
              "profileEvidence",
              "insights",
              "detailedNotes",
              "claims",
              "unknowns",
              "prohibitedInferences",
            ],
          },
          field: string,
          severity: { type: "string", enum: ["blocking", "warning"] },
          quote: string,
          reason: string,
          category: {
            type: "string",
            enum: [
              "profile",
              "experience",
              "skill",
              "education",
              "date",
              "metric",
              "other",
            ],
          },
        },
      },
    },
    unsupportedExtractions: { type: "array", items: string },
    summary: string,
  },
};

export const outputDescription =
  "Independent chunk coverage decision with typed, severity-ranked repair findings, exact source quotes, and unsupported extraction feedback.";
