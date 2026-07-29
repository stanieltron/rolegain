import type {
  ApplicationDraft,
  CompanyResearch,
  FormField,
  JobSearchWorkspace,
} from "../contracts/job-search.js";

export interface GroundedApplicationAnswer {
  fieldId: string;
  value: string;
  evidenceBasis: string;
}

export interface ApplicationContentDraft {
  applicationId: string;
  coverLetter: string;
  answers?: GroundedApplicationAnswer[];
}

export interface CoverLetterRefinement {
  coverLetter: string;
  assistantMessage: string;
  threadId: string;
}

export interface ApplicationAnswerRefinement {
  value: string;
  evidenceBasis: string;
}

export interface TailoredCvContent {
  content: string;
  changeSummary: string[];
}

export interface ApplicationDraftVerification {
  applicationId: string;
  verdict: "pass" | "needs_repair";
  findings: string[];
  repairInstructions: string[];
}

export interface SourceDocument {
  sourceId: string;
  source: string;
  kind: JobSearchWorkspace["sources"][number]["kind"];
  url?: string;
  detailRef?: string;
  content: string;
  truncated: boolean;
}

export interface CoverLetterWriter {
  draft(
    workspace: JobSearchWorkspace,
    applicationIds: string[],
  ): Promise<ApplicationContentDraft[]>;
  refine(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
    message: string,
  ): Promise<CoverLetterRefinement>;
  refineAnswer?(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
    field: FormField,
    message: string,
  ): Promise<ApplicationAnswerRefinement>;
  tailorCv?(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
  ): Promise<TailoredCvContent>;
}

export type CompanyResearchResult = Omit<
  CompanyResearch,
  "status" | "researchedAt" | "error"
>;
