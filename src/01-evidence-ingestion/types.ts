import type {
  CandidateProfile,
  JobSearchWorkspace,
  SourceInsight,
} from "../contracts/job-search.js";
import type {
  CandidateContradictionDraft,
  CandidateUnknown,
  EvidenceClaimDraft,
  ProfileFieldEvidenceDraft,
  ProhibitedInferenceDraft,
  RoleFamilyDraft,
  SearchVocabularyDraft,
} from "../contracts/evidence.js";
import type { SourceChunkNotes } from "./v1/02-chunk-reader/llm-calls/01-chunk-analysis/output.js";
import type {
  ChunkReadJob,
  ChunkReadResult,
} from "./v1/02-chunk-reader/recovery/run-reader-with-coverage.js";
import type { EvidenceChunkCoverage } from "./chunk-budget.js";

export interface CandidateAnalysisResult {
  threadId: string;
  profile: CandidateProfile;
  profileEvidence?: ProfileFieldEvidenceDraft[];
  sourceInsights: SourceAnalysis[];
  unknowns?: Array<Omit<CandidateUnknown, "unknownId">>;
  contradictions?: CandidateContradictionDraft[];
  prohibitedInferences?: ProhibitedInferenceDraft[];
  roleFamilies?: RoleFamilyDraft[];
  searchVocabulary?: SearchVocabularyDraft;
  chunkCoverage?: EvidenceChunkCoverage;
}

export interface SourceAnalysis {
  sourceId: string;
  insights: SourceInsight[];
  knowledgeMarkdown?: string;
  claims?: EvidenceClaimDraft[];
  unknowns?: Array<Omit<CandidateUnknown, "unknownId">>;
  prohibitedInferences?: ProhibitedInferenceDraft[];
}

export interface CandidateAnalysisProgress {
  stage: "reading" | "synthesizing";
  completed: number;
  total: number;
  sourceName?: string;
  limit?: number;
  limitReached?: boolean;
}

export interface CandidateAnalyzer {
  analyze(
    workspace: JobSearchWorkspace,
    message?: string,
    onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>,
  ): Promise<CandidateAnalysisResult>;
}

export interface SourceNotes {
  sourceId: string;
  kind: string;
  name: string;
  url?: string;
  chunks: SourceChunkNotes[];
}

export interface ChunkReadingResult {
  sourceNotes: SourceNotes[];
  sourceInsights: SourceAnalysis[];
  totalChunks: number;
  chunkCoverage?: EvidenceChunkCoverage;
  /** Inspectable fan-out input retained by the standalone pipeline. */
  prepared?: {
    jobs: ChunkReadJob[];
    coverage: EvidenceChunkCoverage;
  };
  /** Ordered one-chunk transaction outputs retained before deterministic join. */
  chunkResults?: ChunkReadResult[];
}
