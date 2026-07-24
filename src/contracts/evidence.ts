export const EVIDENCE_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_PROMPT_VERSION = "evidence-grounding-v3";
export const SOURCE_READER_PROMPT_VERSION = "evidence-grounding-v2";
export const SOURCE_PARSER_VERSION = "rolegain-parser-v1";

export type AccessPolicy = "public" | "private_authorized" | "local_only";
export type EvidenceSupportStatus =
  | "supported"
  | "weakly_supported"
  | "unverified"
  | "contradicted";
export type EvidenceOwnership =
  | "assisted"
  | "contributor"
  | "primary"
  | "shared_owner"
  | "lead"
  | "manager"
  | "end_to_end_owner"
  | "organizational_owner"
  | "unknown";
export type EvidenceMaturity =
  | "concept"
  | "designed"
  | "piloted"
  | "implemented"
  | "operated"
  | "measured"
  | "unknown";
export type EvidenceScope =
  | "task"
  | "process"
  | "component"
  | "system"
  | "service"
  | "site"
  | "team"
  | "department"
  | "product"
  | "organization"
  | "unknown";

export type EvidenceProfileField =
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
  | "languages";

/** Source-owned support for one scalar value selected into the candidate profile. */
export interface ProfileFieldEvidenceDraft {
  field: EvidenceProfileField;
  value: string;
  sourceId: string;
  locator: string;
  quote: string;
}

/** Deterministically verified profile provenance persisted with an evidence run. */
export interface ProfileFieldEvidence extends ProfileFieldEvidenceDraft {
  sourceVersionId: string;
  quoteHash: string;
}

export interface SourceSnapshot {
  sourceId: string;
  sourceVersionId: string;
  candidateId: string;
  kind: "cv" | "document" | "website" | "repository" | "work_sample" | "other";
  originalUriOrName: string;
  contentHash: string;
  retrievedAt: string;
  parserVersion: string;
  accessPolicy: AccessPolicy;
  mimeType: string;
  size: number;
  metadata: Record<string, unknown>;
}

export interface SourceBlock {
  blockId: string;
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  contentHash: string;
  text: string;
}

export interface SourceRef {
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  quote: string;
  quoteHash: string;
}

export interface EvidenceOutcomeDraft {
  description: string;
  metric: string;
  value: string;
}

export interface EvidenceSourceDraft {
  sourceId: string;
  locator: string;
  quote: string;
}

export interface EvidenceClaimDraft {
  action: string;
  capability: string;
  workContexts: string[];
  toolsMethods: string[];
  credentials: string[];
  ownership: EvidenceOwnership;
  maturity: EvidenceMaturity;
  scope: EvidenceScope;
  startDate: string;
  endDate: string;
  outcomes: EvidenceOutcomeDraft[];
  sourceEvidence: EvidenceSourceDraft[];
  supportStatus: EvidenceSupportStatus;
  confidence: number;
  limitations: string[];
}

export interface EvidenceClaim {
  claimId: string;
  candidateId: string;
  experienceId: string | null;
  action: string;
  capability: string;
  workContexts: string[];
  toolsMethods: string[];
  credentials: string[];
  ownership: EvidenceOwnership;
  maturity: EvidenceMaturity;
  scope: EvidenceScope;
  startDate: string | null;
  endDate: string | null;
  outcomes: EvidenceOutcomeDraft[];
  sourceRefs: SourceRef[];
  supportStatus: EvidenceSupportStatus;
  confidence: number;
  limitations: string[];
  status: "active" | "superseded" | "contradicted";
}

export interface CandidateUnknown {
  unknownId: string;
  field: string;
  reason: string;
  materiality: "search" | "feasibility" | "matching" | "low";
  sourceIds: string[];
}

export interface CandidateContradictionDraft {
  field: string;
  values: Array<{ value: string; sourceId: string; quote: string }>;
  explanation: string;
}

export interface CandidateContradiction extends CandidateContradictionDraft {
  contradictionId: string;
  status: "open" | "resolved";
}

export interface ProhibitedInferenceDraft {
  rule: string;
  reason: string;
  sourceIds: string[];
}

export interface ProhibitedInference extends ProhibitedInferenceDraft {
  inferenceId: string;
}

export interface Capability {
  capabilityId: string;
  name: string;
  claimIds: string[];
  workContexts: string[];
  toolsMethods: string[];
  ownershipMax: EvidenceOwnership;
  maturityMax: EvidenceMaturity;
  scopeMax: EvidenceScope;
  recency: number | null;
  evidenceStrength: number;
  outcomes: EvidenceOutcomeDraft[];
  directAliases: string[];
  adjacentAliases: string[];
}

export interface RoleFamilyDraft {
  canonicalTitle: string;
  titleAliases: string[];
  problemPhrases: string[];
  leadingCapabilities: string[];
  roleClass: "direct" | "adjacent" | "stretch";
  geographyLanguageVariants: Array<{
    geography: string;
    language: string;
    titles: string[];
  }>;
  confidence: number;
}

export interface RoleFamily extends Omit<RoleFamilyDraft, "leadingCapabilities"> {
  roleFamilyId: string;
  leadingCapabilityIds: string[];
}

export interface SearchVocabularyDraft {
  titleAliases: string[];
  evidenceIntersections: string[];
  problemPhrases: string[];
  toolsMethodsStandards: string[];
  adjacentDialects: string[];
  seniorityOwnershipModifiers: string[];
  geographyLanguageVariants: string[];
  negativeTerms: string[];
}

export interface CanonicalConstraint<T> {
  value: T | null;
  mode: "hard" | "soft" | "unknown";
  evidenceRef: string | null;
}

export interface CandidateConstraints {
  locations: {
    base: CanonicalConstraint<string>;
    acceptableHubs: CanonicalConstraint<string[]>;
    remoteRegions: CanonicalConstraint<string[]>;
    relocation: CanonicalConstraint<"yes" | "no" | "conditional">;
  };
  employment: {
    types: CanonicalConstraint<string[]>;
    workAuthorization: CanonicalConstraint<string[]>;
    earliestStart: CanonicalConstraint<string>;
  };
  compensation: {
    floor: CanonicalConstraint<{
      amount: number;
      currency: string;
      period: "year" | "month" | "hour";
    }>;
  };
  languages: Array<{
    name: string;
    level: "native" | "professional" | "conversational" | "basic" | "unknown";
    evidenceRef: string | null;
  }>;
}

export interface EvidenceReadiness {
  readyForSearch: boolean;
  blockers: string[];
  warnings: string[];
  counts: {
    sources: number;
    sourceBlocks: number;
    claims: number;
    supportedClaims: number;
    capabilities: number;
    roleFamilies: number;
    unknowns: number;
    contradictions: number;
  };
}

export interface EvidenceRunManifest {
  evidenceRunId: string;
  candidateId: string;
  createdAt: string;
  schemaVersion: string;
  promptVersion: string;
  sourceVersionIds: string[];
  artifacts: string[];
  readiness: EvidenceReadiness;
}
