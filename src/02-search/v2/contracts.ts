import type { JobSourceGroup } from "../../contracts/job-search.js";

export interface SearchV2Lead {
  id: string;
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  employmentType: string;
  url: string;
  sourceKind: "vacancy" | "job_list";
  query: string;
  sourceClass: string;
  snippet: string;
  compensation: string;
  wave: number;
  sourceGroup?: JobSourceGroup;
}

export interface SearchV2Link {
  text: string;
  url: string;
}

export interface SearchV2JobPosting {
  title: string;
  company: string;
  description: string;
  location: string;
  employmentType: string;
  datePosted: string;
  validThrough: string;
  url: string;
}

export interface SearchV2Capture {
  id: string;
  lead: SearchV2Lead;
  suppliedUrl: string;
  finalUrl: string;
  httpStatus: number;
  navigationError: string;
  pageTitle: string;
  body: string;
  links: SearchV2Link[];
  forms: Array<{ action: string; text: string; fields: number }>;
  jobPosting?: SearchV2JobPosting;
  fallback?: {
    status: number;
    finalUrl: string;
    contentType: string;
    error: string;
    recovered: boolean;
  };
  signals: SearchV2Signals;
}

export interface SearchV2Signals {
  pageTitleMatchesExpected: boolean;
  expectedTitleContext: string;
  definiteClosureContext: string;
  conditionalClosureContext: string;
  staffingPoolContext: string;
  applicationLoadingContext: string;
  matchingLinks: SearchV2Link[];
  relevantLinkCount: number;
  formCount: number;
  hasUsableEvidence: boolean;
}

export interface SearchV2Child {
  title: string;
  company: string;
  url: string;
}

export interface SearchV2Decision {
  id: string;
  status: "vacancy" | "job_list" | "reject";
  reason: string;
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  employmentType: string;
  applyUrl: string;
  compensation: string;
  children: SearchV2Child[];
}

export interface SearchV2WaveAudit {
  wave: number;
  leads: number;
  captures: number;
  vacancies: number;
  jobLists: number;
  rejected: number;
  expandedChildren: number;
  validated: number;
  durationMs: number;
}
