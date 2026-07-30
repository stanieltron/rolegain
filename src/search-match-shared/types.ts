import type {
  ApplicationDraft,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../contracts/job-search.js";

export interface DiscoveredJob {
  id: string;
  title: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  compensation?: string;
  sourceKind?: "vacancy" | "job_list" | "career_page";
  discoveryQuery?: string;
  discoveryWave?: number;
  sourceClass?: string;
}

export interface LiveCandidate {
  company: string;
  job: DiscoveredJob;
  preliminaryFit: number;
}

export interface ApplicationSchemaAudit {
  observedQuestionCount: number;
  mappedQuestionCount: number;
  fingerprint: string;
  issues: string[];
  verifiedByAgent: boolean;
}

export interface ObservedApplicationField {
  label: string;
  externalName: string;
  tag: string;
  inputType: string;
  placeholder: string;
  required: boolean;
  options: string[];
  hasCombobox: boolean;
  allowsManualEntry: boolean;
}

export interface OpportunityProgressUpdate {
  activity?: string;
  item?: {
    id: string;
    jobNumber?: number;
    company: string;
    title: string;
    sourceUrl: string;
  };
  phase?: "validation" | "match" | "application" | "application_verification";
  state?: "waiting" | "running" | "passed" | "failed" | "bench" | "selected";
  fit?: number;
  reason?: string;
  validationDisposition?: JobResearchFailure["disposition"];
}

export type OpportunityProgressReporter = (
  update: OpportunityProgressUpdate,
) => void | Promise<void>;

export interface OpportunityResearchProvider {
  cancelAll?(): Promise<void>;
  cancel?(candidateId: string): Promise<void>;
  research(
    workspace: JobSearchWorkspace,
    options?: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
      onValidatedOpportunity?: (
        opportunity: JobOpportunity,
      ) => void | Promise<void>;
    },
  ): Promise<{
    opportunities: JobOpportunity[];
    applications: ApplicationDraft[];
    failures?: JobResearchFailure[];
    seenUrls?: string[];
  }>;
  researchAndAssess?(
    workspace: JobSearchWorkspace,
    options?: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
      onMatchedOpportunity?: (
        opportunity: JobOpportunity,
      ) => void | Promise<void>;
    },
  ): Promise<{
    opportunities: JobOpportunity[];
    applications: ApplicationDraft[];
    failures?: JobResearchFailure[];
    seenUrls?: string[];
  }>;
  assess?(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ): Promise<
    | JobOpportunity[]
    | { opportunities: JobOpportunity[]; failures: JobResearchFailure[] }
  >;
  inspectApplications?(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ): Promise<{ applications: ApplicationDraft[]; failures: JobResearchFailure[] }>;
  revalidate?(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ): Promise<{ opportunities: JobOpportunity[]; failures: JobResearchFailure[] }>;
}
