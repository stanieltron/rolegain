import type { LiveCandidate } from "../../../search-match-shared/types.js";

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
  return searchLeadLooksExpandable(candidate)
    ? { kind: "vacancy_search", candidate }
    : { kind: "vacancy", candidate };
}

export function searchLeadLooksExpandable(candidate: LiveCandidate) {
  if (
    candidate.job.sourceKind === "job_list" ||
    candidate.job.sourceKind === "career_page"
  )
    return true;
  const title = candidate.job.title.trim();
  let url: URL;
  try {
    url = new URL(candidate.job.jobUrl);
  } catch {
    return false;
  }
  const pathname = decodeURIComponent(url.pathname)
    .toLowerCase()
    .replace(/\/+$/, "");
  const genericTitle =
    /^(?:remote\s+)?(?:crypto\s*&?\s*web3|blockchain|defi|engineering|smart contract engineer)?\s*jobs(?:\s+(?:listing|list|board))?$/i.test(
      title,
    ) ||
    /^(?:current\s+)?(?:job\s+)?openings$|^open positions$|^careers?$/i.test(
      title,
    );
  const genericPath =
    /\/role\/r\/[^/]+$/.test(pathname) ||
    /\/q-[^/]*-jobs(?:\.html)?$/.test(pathname) ||
    /^\/remote(?:_[a-z-]+)?$/.test(pathname) ||
    (/\/jobs\/[^/]+$/.test(pathname) && url.searchParams.has("page")) ||
    (["/jobs", "/careers", "/open-positions"].includes(pathname) &&
      genericTitle);
  return genericTitle || genericPath;
}
