import type {
  CandidateProfile,
  SourceInsight,
} from "../../../../../contracts/job-search.js";
import type {
  CandidateUnknown,
  EvidenceClaimDraft,
  ProfileFieldEvidenceDraft,
  ProhibitedInferenceDraft,
} from "../../../../../contracts/evidence.js";

export interface SourceChunkNotes {
  profileFacts: Pick<
    CandidateProfile,
    | "name"
    | "email"
    | "phone"
    | "linkedin"
    | "github"
    | "website"
    | "location"
    | "headline"
    | "summary"
    | "skills"
    | "languages"
  >;
  profileEvidence: ProfileFieldEvidenceDraft[];
  insights: SourceInsight[];
  detailedNotes: string;
  claims: EvidenceClaimDraft[];
  unknowns: Array<Omit<CandidateUnknown, "unknownId">>;
  prohibitedInferences: ProhibitedInferenceDraft[];
}

const string = { type: "string" };
const stringArray = { type: "array", items: string };
const profileEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "value", "sourceId", "locator", "quote"],
  properties: {
    field: {
      type: "string",
      enum: [
        "name",
        "email",
        "phone",
        "linkedin",
        "github",
        "website",
        "location",
        "headline",
        "summary",
        "skills",
        "languages",
      ],
    },
    value: string,
    sourceId: string,
    locator: string,
    quote: string,
  },
};
const insightSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "summary", "evidence", "skills", "category"],
  properties: {
    id: string,
    title: string,
    summary: string,
    evidence: string,
    skills: stringArray,
    category: {
      type: "string",
      enum: [
        "project",
        "experience",
        "skill",
        "achievement",
        "education",
        "other",
      ],
    },
  },
};
const sourceEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId", "locator", "quote"],
  properties: { sourceId: string, locator: string, quote: string },
};
const outcomeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["description", "metric", "value"],
  properties: { description: string, metric: string, value: string },
};
const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "capability",
    "workContexts",
    "toolsMethods",
    "credentials",
    "ownership",
    "maturity",
    "scope",
    "startDate",
    "endDate",
    "outcomes",
    "sourceEvidence",
    "supportStatus",
    "confidence",
    "limitations",
  ],
  properties: {
    action: string,
    capability: string,
    workContexts: stringArray,
    toolsMethods: stringArray,
    credentials: stringArray,
    ownership: {
      type: "string",
      enum: [
        "assisted",
        "contributor",
        "primary",
        "shared_owner",
        "lead",
        "manager",
        "end_to_end_owner",
        "organizational_owner",
        "unknown",
      ],
    },
    maturity: {
      type: "string",
      enum: [
        "concept",
        "designed",
        "piloted",
        "implemented",
        "operated",
        "measured",
        "unknown",
      ],
    },
    scope: {
      type: "string",
      enum: [
        "task",
        "process",
        "component",
        "system",
        "service",
        "site",
        "team",
        "department",
        "product",
        "organization",
        "unknown",
      ],
    },
    startDate: string,
    endDate: string,
    outcomes: { type: "array", items: outcomeSchema },
    sourceEvidence: { type: "array", items: sourceEvidenceSchema },
    supportStatus: {
      type: "string",
      enum: ["supported", "weakly_supported", "unverified", "contradicted"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    limitations: stringArray,
  },
};
const unknownSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "reason", "materiality", "sourceIds"],
  properties: {
    field: string,
    reason: string,
    materiality: {
      type: "string",
      enum: ["search", "feasibility", "matching", "low"],
    },
    sourceIds: stringArray,
  },
};
const prohibitedInferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule", "reason", "sourceIds"],
  properties: { rule: string, reason: string, sourceIds: stringArray },
};

export const outputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "profileFacts",
    "profileEvidence",
    "insights",
    "detailedNotes",
    "claims",
    "unknowns",
    "prohibitedInferences",
  ],
  properties: {
    profileFacts: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "email",
        "phone",
        "linkedin",
        "github",
        "website",
        "location",
        "headline",
        "summary",
        "skills",
        "languages",
      ],
      properties: {
        name: string,
        email: string,
        phone: string,
        linkedin: string,
        github: string,
        website: string,
        location: string,
        headline: string,
        summary: string,
        skills: stringArray,
        languages: stringArray,
      },
    },
    profileEvidence: { type: "array", items: profileEvidenceSchema },
    insights: { type: "array", items: insightSchema },
    detailedNotes: string,
    claims: { type: "array", items: claimSchema },
    unknowns: { type: "array", items: unknownSchema },
    prohibitedInferences: { type: "array", items: prohibitedInferenceSchema },
  },
};

export const outputDescription =
  "Typed profile facts, insights, detailed notes, atomic evidence claims with exact quotes, unknowns, and prohibited inferences.";
