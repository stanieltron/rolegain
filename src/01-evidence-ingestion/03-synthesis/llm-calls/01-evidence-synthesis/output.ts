import type { CandidateProfile } from "../../../../contracts/job-search.js";
import type {
  CandidateContradictionDraft,
  CandidateUnknown,
  ProfileFieldEvidenceDraft,
  ProhibitedInferenceDraft,
  RoleFamilyDraft,
  SearchVocabularyDraft,
} from "../../../../contracts/evidence.js";

export interface EvidenceSynthesisOutput {
  profile: CandidateProfile;
  profileEvidence: ProfileFieldEvidenceDraft[];
  unknowns?: Array<Omit<CandidateUnknown, "unknownId">>;
  contradictions?: CandidateContradictionDraft[];
  prohibitedInferences?: ProhibitedInferenceDraft[];
  roleFamilies?: RoleFamilyDraft[];
  searchVocabulary?: SearchVocabularyDraft;
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
const contradictionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "values", "explanation"],
  properties: {
    field: string,
    values: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "sourceId", "quote"],
        properties: { value: string, sourceId: string, quote: string },
      },
    },
    explanation: string,
  },
};
const roleFamilySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "canonicalTitle",
    "titleAliases",
    "problemPhrases",
    "leadingCapabilities",
    "roleClass",
    "geographyLanguageVariants",
    "confidence",
  ],
  properties: {
    canonicalTitle: string,
    titleAliases: stringArray,
    problemPhrases: stringArray,
    leadingCapabilities: stringArray,
    roleClass: { type: "string", enum: ["direct", "adjacent", "stretch"] },
    geographyLanguageVariants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["geography", "language", "titles"],
        properties: { geography: string, language: string, titles: stringArray },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};
const searchVocabularySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "titleAliases",
    "evidenceIntersections",
    "problemPhrases",
    "toolsMethodsStandards",
    "adjacentDialects",
    "seniorityOwnershipModifiers",
    "geographyLanguageVariants",
    "negativeTerms",
  ],
  properties: {
    titleAliases: stringArray,
    evidenceIntersections: stringArray,
    problemPhrases: stringArray,
    toolsMethodsStandards: stringArray,
    adjacentDialects: stringArray,
    seniorityOwnershipModifiers: stringArray,
    geographyLanguageVariants: stringArray,
    negativeTerms: stringArray,
  },
};
const profileSchema = {
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
    "salaryExpectation",
    "targetLocations",
    "workplace",
    "employmentTypes",
    "workAuthorization",
    "startDate",
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
    salaryExpectation: string,
    targetLocations: string,
    workplace: string,
    employmentTypes: string,
    workAuthorization: string,
    startDate: string,
    skills: stringArray,
    languages: stringArray,
  },
};

export const outputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile",
    "profileEvidence",
    "unknowns",
    "contradictions",
    "prohibitedInferences",
    "roleFamilies",
    "searchVocabulary",
  ],
  properties: {
    profile: profileSchema,
    profileEvidence: { type: "array", items: profileEvidenceSchema },
    unknowns: { type: "array", items: unknownSchema },
    contradictions: { type: "array", items: contradictionSchema },
    prohibitedInferences: { type: "array", items: prohibitedInferenceSchema },
    roleFamilies: { type: "array", items: roleFamilySchema },
    searchVocabulary: searchVocabularySchema,
  },
};

export const outputDescription =
  "Consolidated profile, unknowns, contradictions, prohibited inferences, role families, and search vocabulary. Raw claims are not regenerated.";
