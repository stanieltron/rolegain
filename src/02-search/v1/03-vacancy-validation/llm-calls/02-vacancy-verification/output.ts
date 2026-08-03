import type { VacancyInterpretation } from "../../interpreter.js";

export type VacancyVerificationOutput = VacancyInterpretation;

const string = { type: "string" } as const;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "pageType", "openStatus", "title", "company", "location",
    "workplaceType", "employmentType", "description", "compensation",
    "applyUrl", "publishedAt", "validThrough", "confidence",
    "ambiguities", "evidence",
  ],
  properties: {
    pageType: {
      type: "string",
      enum: ["vacancy", "job_list", "company_page", "closed_job", "blocked", "unknown"],
    },
    openStatus: {
      type: "string",
      enum: ["open", "probably_open", "unknown", "closed"],
    },
    title: string,
    company: string,
    location: string,
    workplaceType: string,
    employmentType: string,
    description: string,
    compensation: string,
    applyUrl: string,
    publishedAt: string,
    validThrough: string,
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    ambiguities: { type: "array", items: string },
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
} as const;

export const outputDescription =
  "Page classification, open status, vacancy facts, apply URL, confidence, ambiguities, and per-field source text.";
