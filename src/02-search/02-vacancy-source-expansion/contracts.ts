import type { LiveCandidate } from "../../search-match-shared/types.js";

export type SearchLead =
  | { kind: "vacancy"; candidate: LiveCandidate }
  | { kind: "vacancy_search"; candidate: LiveCandidate };

export interface VacancySourceCheckpoint {
  version: 1;
  sourceId: string;
  candidateId: string;
  sourceUrl: string;
  sourceName: string;
  sourceClass: string;
  discoveryQuery: string;
  cursorUrl: string;
  hasMore: boolean;
  pagesInspected: number;
  vacanciesInspected: number;
  vacanciesEmitted: number;
  seenVacancyUrls: string[];
  /** Extracted concrete vacancies waiting for a later target-driven run. */
  pendingVacancies: LiveCandidate[];
  firstSeenAt: string;
  lastSynchronizedAt: string;
  lastHeadRefreshAt: string;
  browserAgent?: SourceBrowserAgentState;
  lastError?: string;
}

export interface SourceBrowserReplayStep {
  kind: "scroll" | "click";
  repetitions: number;
  label?: string;
  href?: string;
}

export interface SourceBrowserAgentState {
  version: 1;
  replaySteps: SourceBrowserReplayStep[];
  observedVacancyUrls: string[];
  interactionsCompleted: number;
  exhausted: boolean;
  lastObservedUrl: string;
  lastActionAt: string;
  lastDecisionReason?: string;
}

export interface VacancySourcePage {
  pageUrl: string;
  nextUrl?: string;
  pageTitle: string;
  metaDescription: string;
  h1: string;
  headings: string[];
  bodyText: string;
  applyLinks: Array<{ text: string; url: string }>;
  links: Array<{ text: string; url: string }>;
  interactiveContinuation: boolean;
}

export function classifySearchLead(candidate: LiveCandidate): SearchLead {
  return candidate.job.sourceKind === "job_list" ||
    candidate.job.sourceKind === "career_page"
    ? { kind: "vacancy_search", candidate }
    : { kind: "vacancy", candidate };
}
