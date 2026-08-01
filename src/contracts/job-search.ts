export type WorkspacePhase = "intake" | "search" | "applications";

export interface CandidateSource {
  id: string;
  kind: "cv" | "document" | "github" | "portfolio" | "repository" | "webpage";
  name: string;
  url?: string;
  /** Profile field that automatically owns and refreshes this evidence source. */
  profileField?: "linkedin" | "github" | "website";
  content?: string;
  /** Supplemental-only SHA-256 used to prevent duplicate evidence. */
  contentHash?: string;
  originalFile?: {
    name: string;
  };
  status: "processing" | "ready" | "needs_review" | "analysis_failed";
  /** Source must be reread before the next evidence ledger is committed. */
  analysisRequired?: boolean;
  /** Path relative to the data root for the source's detailed Tier 2 note. */
  knowledgePath?: string;
  insights: SourceInsight[];
  error?: string;
  addedAt: string;
}

export interface SourceInsight {
  id: string;
  title: string;
  summary: string;
  evidence: string;
  skills: string[];
  category:
    | "project"
    | "experience"
    | "skill"
    | "achievement"
    | "education"
    | "other";
  /** Path relative to the data root for details supporting this evidence item. */
  detailRef?: string;
}

export interface CandidateIntelligence {
  status: "idle" | "analyzing" | "ready" | "failed";
  threadId?: string;
  error?: string;
  progress?: {
    stage: "reading" | "synthesizing";
    completed: number;
    total: number;
    sourceName?: string;
  };
  evidenceRun?: {
    id: string;
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
  };
  evidenceReview?: {
    claims: Array<{
      claimId: string;
      decision: "candidate_confirmed" | "keep_weak" | "remove";
      note?: string;
      reviewedAt: string;
    }>;
    contradictions: Array<{
      contradictionId: string;
      decision: "use_value" | "both_valid" | "keep_unresolved";
      selectedValue?: string;
      reviewedAt: string;
    }>;
  };
}

export interface IntakeQuestion {
  id: string;
  category: "identity" | "preferences" | "eligibility" | "experience";
  prompt: string;
  rationale: string;
  required: boolean;
  answer: string;
}

export interface CandidateProfile {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  /** Candidate fact used for application forms only; never a discovery input. */
  location: string;
  headline: string;
  summary: string;
  salaryExpectation: string;
  /** Physical locations the candidate accepts for Hybrid or On-site work. */
  targetLocations: string;
  /** Selected workplace modes: Remote, Hybrid, and/or On-site. */
  workplace: string;
  employmentTypes: string;
  workAuthorization: string;
  startDate: string;
  skills: string[];
  languages: string[];
}

export interface RequirementEvidence {
  claimId?: string;
  sourceId: string;
  sourceName: string;
  sourceVersionId?: string;
  locator?: string;
  excerpt: string;
  claimConfidence?: number;
}

export interface RequirementMatch {
  id: string;
  kind: "required" | "preferred";
  category?: "responsibility" | "mandatory" | "preferred" | "constraint";
  requirement: string;
  status: "matched" | "partial" | "missing";
  matchClass?:
    | "explicit"
    | "strong_adjacent"
    | "weak_adjacent"
    | "unsupported"
    | "contradicted";
  confidence?: number;
  importanceWeight?: number;
  credit?: number;
  gapClass?:
    | "none"
    | "dialect"
    | "tool_platform"
    | "work_context"
    | "scope"
    | "discipline_credential"
    | "feasibility"
    | "evidence_quality";
  gapSeverity?: "none" | "learnable" | "substantial" | "blocking";
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
  evidence: RequirementEvidence[];
}

export interface JobDiscoveryProvenance {
  query: string;
  wave: number;
  sourceClass: string;
  discoveredAt: string;
}

export interface JobSourceGroup {
  id: string;
  name: string;
  url: string;
  sourceClass: string;
}

export interface JobOpportunity {
  id: string;
  /** Canonical evidence run used to discover and assess this vacancy. */
  evidenceRunId?: string;
  /** Search run containing discovery queries, waves, coverage, and validation metrics. */
  searchRunId?: string;
  /** Permanent app-wide sequence number allocated when this vacancy is first seen. */
  jobNumber?: number;
  company: string;
  title: string;
  location: string;
  workplace: string;
  compensation: string;
  sourceUrl: string;
  applyUrl: string;
  capturedAt: string;
  fit: number;
  summary: string;
  description?: string;
  requirements: string[];
  requirementMatches: RequirementMatch[];
  strengths: string[];
  gaps: string[];
  lastValidatedAt?: string;
  opportunityConfidence?: number;
  validation?: {
    status: "live" | "closed" | "talent_pool" | "uncertain";
    sourceConfidence: number;
    retrievedAt: string;
    descriptionFingerprint: string;
    responsibilitiesText: string;
    qualificationsText: string;
    riskSignals: string[];
  };
  discoveryProvenance?: JobDiscoveryProvenance[];
  /** Listing/marketplace page from which this concrete vacancy was extracted. */
  sourceGroup?: JobSourceGroup;
  feasibilityGate?: {
    status: "passed" | "unknown" | "blocked";
    reasons: string[];
  };
  scoreBreakdown?: {
    requirementCoverage: number;
    scopeOwnershipAlignment: number;
    domainContextAlignment: number;
    softPreferenceFit: number;
    final: number;
  };
  skepticalReview?: {
    acceptedScore: number;
    revisedScore: number;
    inflationFlags: string[];
    feasibilityFlags: string[];
    statusConfidence: number;
    decision: "accepted" | "revised" | "rejected";
    rationale: string;
  };
  portfolioCategory?:
    | "apply_now"
    | "credible_adjacent"
    | "stretch"
    | "watchlist"
    | "rejected";
}

export interface JobResearchFailure {
  id: string;
  /** Permanent app-wide sequence number shared with the vacancy pipeline. */
  jobNumber?: number;
  company: string;
  title: string;
  location: string;
  sourceUrl: string;
  applyUrl: string;
  stage: "vacancy_validation" | "requirements" | "form" | "expired";
  /** Search-stage disposition. Only `rejected` is a confirmed hard exclusion. */
  disposition?: SearchValidationDisposition;
  reasonCode?: SearchValidationReasonCode;
  reason: string;
  capturedAt: string;
}

export type SearchValidationDisposition =
  | "rejected"
  | "manual_review"
  | "unresolved"
  | "source_page"
  | "duplicate";

export type SearchValidationReasonCode =
  | "closed_or_unavailable"
  | "location_or_workplace"
  | "hard_candidate_constraint"
  | "access_restricted"
  | "technical_failure"
  | "not_a_vacancy"
  | "duplicate"
  | "matching_verification"
  | "application_form";

export type SearchPipelineState =
  | "waiting"
  | "running"
  | "passed"
  | "failed"
  | "bench"
  | "selected";

export interface SearchPipelineItem {
  id: string;
  jobNumber?: number;
  company: string;
  title: string;
  sourceUrl: string;
  validation: SearchPipelineState;
  match: SearchPipelineState;
  application: SearchPipelineState;
  applicationVerification: SearchPipelineState;
  /** True only when the resulting application has no remaining required input. */
  applicationReady?: boolean;
  fit?: number;
  reason?: string;
  validationDisposition?: SearchValidationDisposition;
  sourceGroup?: JobSourceGroup;
}

export interface SearchProgressEvent {
  id: string;
  message: string;
  createdAt: string;
}

export type BackgroundSearchOperation =
  | "prepare"
  | "prepare_search_ready";

export interface BackgroundExecutionControl {
  state: "running" | "stopped";
  stoppedAt?: string;
  resumeCandidateAnalysis?: boolean;
  resumeProfileSourceSync?: boolean;
  resumeSearch?: BackgroundSearchOperation;
}

export interface WorkflowExecutionState {
  id?: string;
  type?:
    | "analyze"
    | "prepare"
    | "prepare-search-ready"
    | "find-more"
    | "revalidate-search"
    | "tailor-cv";
  status:
    | "idle"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  error?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
}

export interface FormField {
  id: string;
  canonicalKey?: string;
  externalName?: string;
  label: string;
  type:
    | "text"
    | "email"
    | "tel"
    | "textarea"
    | "select"
    | "file"
    | "date"
    | "checkbox";
  value: string;
  required: boolean;
  source: "profile" | "cv" | "generated" | "user";
  confidence: number;
  options?: string[];
  evidence?: string;
}

export interface CompanyResearchSource {
  title: string;
  url: string;
  evidence: string;
}

export interface CompanyResearch {
  status: "ready" | "failed";
  company: string;
  overview: string;
  productsAndServices: string[];
  customersAndMarkets: string[];
  businessModel: string;
  cultureAndValues: string[];
  recentSignals: string[];
  tailoringAngles: string[];
  sources: CompanyResearchSource[];
  researchedAt: string;
  error?: string;
}

export interface TailoredCv {
  status: "processing" | "ready" | "failed";
  content: string;
  changeSummary: string[];
  fileName: string;
  generatedAt?: string;
  error?: string;
}

export interface ApplicationDraft {
  id: string;
  jobId: string;
  /** User-added drafts remain in the managed application list even if automation is incomplete. */
  addedBy?: "agent" | "user";
  status: "needs_input" | "ready_to_send";
  coverLetter: string;
  coverLetterThreadId?: string;
  coverLetterChat: CoverLetterChatMessage[];
  /** Public-web employer context collected only after this job reaches Applications. */
  companyResearch?: CompanyResearch;
  /** Candidate-requested, job-specific CV generated only from the Applications UI. */
  tailoredCv?: TailoredCv;
  formFields: FormField[];
  missingQuestions: string[];
  adapter: "openai-careers" | "greenhouse" | "lever" | "ashby" | "generic";
  liveFormValidated: boolean;
  formSchema?: {
    observedQuestionCount: number;
    mappedQuestionCount: number;
    fingerprint: string;
    issues: string[];
    verifiedByAgent: boolean;
  };
  outcome?: "rejected_by_user" | "unsuccessful" | "applied_waiting";
  updatedAt: string;
}

export interface CoverLetterChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface JobSearchWorkspace {
  id: string;
  candidateId: string;
  phase: WorkspacePhase;
  profile: CandidateProfile;
  sources: CandidateSource[];
  questions: IntakeQuestion[];
  opportunities: JobOpportunity[];
  /** Live, eligible vacancies produced by the search verifier before matching. */
  searchReadyOpportunities: JobOpportunity[];
  applications: ApplicationDraft[];
  rejectedOpportunities: JobResearchFailure[];
  /** Non-rejections that did not proceed to matching and need review, retry, or expansion. */
  searchValidationIssues: JobResearchFailure[];
  /** Persistent latest pipeline state for every numbered job seen for this candidate. */
  jobHistory: SearchPipelineItem[];
  seenJobUrls: string[];
  searchConfig: {
    discoveryTarget: number;
    applicationTarget: number;
  };
  sharedAnswers: Record<string, string>;
  /** Persisted position in the gated Profile setup wizard. */
  profileSetupStep?: 1 | 2 | 3 | 4;
  /** True when first discovery has not run or candidate inputs changed afterward. */
  discoveryNeedsRun: boolean;
  searchProgress?: {
    stage:
      | "looking"
      | "verifying"
      | "filling"
      | "ready"
      | "failed"
      | "stopped";
    target: number;
    found: number;
    error?: string;
    activity?: string;
    updatedAt?: string;
    items?: SearchPipelineItem[];
    events?: SearchProgressEvent[];
    /** Applications present before this run; used to resume the same five-item batch. */
    baselineApplicationJobIds?: string[];
  };
  backgroundExecution?: BackgroundExecutionControl;
  /** Live queue state supplied by the web API; it is not persisted in candidate data. */
  workflowExecution?: WorkflowExecutionState;
  profileCompleteness: number;
  finalCv: string;
  intelligence: CandidateIntelligence;
  updatedAt: string;
}
