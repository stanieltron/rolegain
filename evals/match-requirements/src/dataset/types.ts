import type {
  EvidenceMaturity,
  EvidenceOwnership,
  EvidenceScope,
  EvidenceSupportStatus,
} from "../../../../src/contracts/evidence.js";
import type {
  JobOpportunity,
  JobSearchWorkspace,
  RequirementMatch,
} from "../../../../src/contracts/job-search.js";
import type { CanonicalClaimCitation } from "../../../../src/search-match-shared/evidence-context.js";

export const MATCH_REQUIREMENTS_CORPUS_VERSION = "2.0.0";

export type MatchEvalFamily =
  | "direct"
  | "missing"
  | "adjacent"
  | "scope_ownership"
  | "duration_quantity"
  | "evidence_quality"
  | "requirement_extraction"
  | "adversarial"
  | "citation_integrity";

export type MatchEvalSplit = "development" | "test";
export type MatchEvalDifficulty = "basic" | "intermediate" | "hard";
export type MatchEvalLabelStatus = "machine_reviewed" | "human_reviewed";
export type VerifierChallengeType =
  | "clean_control"
  | "omitted_requirement"
  | "inflated_match"
  | "invalid_citation"
  | "missing_with_evidence"
  | "wrong_category"
  | "phantom_requirement"
  | "weak_claim_promoted";

export interface MatchEvalClaim {
  key: string;
  quote: string;
  action: string;
  capability: string;
  toolsMethods?: string[];
  workContexts?: string[];
  credentials?: string[];
  ownership?: EvidenceOwnership;
  maturity?: EvidenceMaturity;
  scope?: EvidenceScope;
  supportStatus?: EvidenceSupportStatus;
  confidence?: number;
  limitations?: string[];
  startDate?: string;
  endDate?: string;
}

export interface ExpectedRequirement {
  id: string;
  /** Exact employer wording used during adjudication and challenge construction. */
  requirement: string;
  /** At least one alias must have every term present in the generated row. */
  aliases: string[][];
  category: NonNullable<RequirementMatch["category"]>;
  allowedMatchClasses: Array<NonNullable<RequirementMatch["matchClass"]>>;
  allowedClaimKeys: string[];
  critical?: boolean;
  rationale: string;
}

export interface MatchRequirementsEvalCase {
  id: string;
  description: string;
  family: MatchEvalFamily;
  split: MatchEvalSplit;
  difficulty: MatchEvalDifficulty;
  labelStatus: MatchEvalLabelStatus;
  tags: string[];
  title: string;
  responsibilities: string[];
  qualifications: string[];
  claims: MatchEvalClaim[];
  expected: ExpectedRequirement[];
  contradictions?: Array<{
    field: string;
    values: Array<{ value: string; claimKey: string }>;
    explanation: string;
  }>;
  prohibitedInferences?: Array<{
    rule: string;
    reason: string;
    claimKeys: string[];
  }>;
  verifierChallenge?: VerifierChallengeType;
  repairChallenge?: Exclude<VerifierChallengeType, "clean_control">;
}

export interface PreparedMatchEvalCase {
  testCase: MatchRequirementsEvalCase;
  workspace: JobSearchWorkspace;
  opportunity: JobOpportunity;
  sourceLedger: CanonicalClaimCitation[];
  claimIdByKey: Record<string, string>;
}

export interface RequirementRowGrade {
  expectedId: string;
  generatedIndex?: number;
  generatedRequirement?: string;
  found: boolean;
  categoryPassed: boolean;
  matchClassPassed: boolean;
  evidencePassed: boolean;
  passed: boolean;
  reasons: string[];
}

export interface MatchEvalGrade {
  passed: boolean;
  requirementRecall: number;
  requirementPrecision: number;
  rowAccuracy: number;
  citationPrecision: number;
  criticalFailures: string[];
  extraRequirements: string[];
  rows: RequirementRowGrade[];
}
