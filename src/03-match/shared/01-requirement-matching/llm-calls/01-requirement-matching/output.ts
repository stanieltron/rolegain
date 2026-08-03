import type { RequirementMatch } from "../../../../../contracts/job-search.js";

export interface AgentRequirementAssessment {
  jobId: string;
  requirements: Array<{
    kind: RequirementMatch["kind"];
    category?: RequirementMatch["category"];
    requirement: string;
    status: RequirementMatch["status"];
    matchClass?: RequirementMatch["matchClass"];
    confidence?: number;
    gapClass?: RequirementMatch["gapClass"];
    gapSeverity?: RequirementMatch["gapSeverity"];
    normalizedCapability?: string;
    minimumDuration?: number;
    requiredOwnership?: string;
    requiredMaturity?: string;
    requiredScope?: string;
    requiredWorkContext?: string;
    requiredToolMethod?: string;
    requiredCredential?: string;
    ambiguityFlags?: string[];
    sourceLocator?: string;
    explanation: string;
    evidence: Array<{
      claimId?: string;
      sourceId: string;
      sourceVersionId?: string;
      locator?: string;
      excerpt: string;
    }>;
  }>;
}

/** One model invocation evaluates exactly one job. */
export type RequirementAssessmentOutput = AgentRequirementAssessment;

export const requirementRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind", "category", "requirement", "status", "matchClass",
    "confidence", "gapClass", "gapSeverity", "normalizedCapability",
    "minimumDuration", "requiredOwnership", "requiredMaturity",
    "requiredScope", "requiredWorkContext", "requiredToolMethod",
    "requiredCredential", "ambiguityFlags", "sourceLocator",
    "explanation", "evidence",
  ],
  properties: {
    kind: { type: "string", enum: ["required", "preferred"] },
    category: {
      type: "string",
      enum: ["responsibility", "mandatory", "preferred", "constraint"],
    },
    requirement: { type: "string" },
    status: { type: "string", enum: ["matched", "partial", "missing"] },
    matchClass: {
      type: "string",
      enum: [
        "explicit",
        "strong_adjacent",
        "weak_adjacent",
        "unsupported",
        "contradicted",
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    gapClass: {
      type: "string",
      enum: [
        "none",
        "dialect",
        "tool_platform",
        "work_context",
        "scope",
        "discipline_credential",
        "feasibility",
        "evidence_quality",
      ],
    },
    gapSeverity: {
      type: "string",
      enum: ["none", "learnable", "substantial", "blocking"],
    },
    normalizedCapability: { type: "string" },
    minimumDuration: { type: "number", minimum: 0 },
    requiredOwnership: { type: "string" },
    requiredMaturity: { type: "string" },
    requiredScope: { type: "string" },
    requiredWorkContext: { type: "string" },
    requiredToolMethod: { type: "string" },
    requiredCredential: { type: "string" },
    ambiguityFlags: { type: "array", items: { type: "string" } },
    sourceLocator: { type: "string" },
    explanation: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "claimId",
          "sourceId",
          "sourceVersionId",
          "locator",
          "excerpt",
        ],
        properties: {
          claimId: { type: "string" },
          sourceId: { type: "string" },
          sourceVersionId: { type: "string" },
          locator: { type: "string" },
          excerpt: { type: "string" },
        },
      },
    },
  },
} as const;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "requirements"],
  properties: {
    jobId: { type: "string" },
    requirements: {
      type: "array",
      items: requirementRowSchema,
    },
  },
} as const;

export const outputDescription =
  "One job's exhaustive requirement matrix with category, match class, confidence, gap, normalized dimensions, explanation, and exact claim citations.";
