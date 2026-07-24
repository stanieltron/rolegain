import type { ListingVacancyLead } from "../../interpreter.js";

export interface ListingExtractionOutput {
  jobs: ListingVacancyLead[];
}

const string = { type: "string" } as const;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title", "company", "location", "workplaceType", "employmentType",
          "description", "compensation", "jobUrl", "applyUrl", "openStatus",
          "publishedAt", "validThrough", "evidence",
        ],
        properties: {
          title: string,
          company: string,
          location: string,
          workplaceType: string,
          employmentType: string,
          description: string,
          compensation: string,
          jobUrl: string,
          applyUrl: string,
          openStatus: {
            type: "string",
            enum: ["open", "probably_open", "unknown", "closed"],
          },
          publishedAt: string,
          validThrough: string,
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "sourceText"],
              properties: { field: string, sourceText: string },
            },
          },
        },
      },
    },
  },
} as const;

export const outputDescription =
  "Zero or more explicit vacancy leads whose URLs occur in the frozen snapshot.";
