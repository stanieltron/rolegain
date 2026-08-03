import type { VacancySourcePage } from "../contracts.js";

export interface SourceAgentControl {
  id: string;
  text: string;
  ariaLabel: string;
  title: string;
  href: string;
  disabled: boolean;
}

export interface SourceAgentObservation {
  url: string;
  title: string;
  pageText: string;
  controls: SourceAgentControl[];
  scroll: { top: number; viewport: number; height: number };
  capturedLinkCount: number;
  newlyObservedLinkCount: number;
}

export interface SourceAgentDecision {
  action: "click" | "scroll" | "wait" | "stop";
  controlId: string;
  completion: "continue" | "exhausted" | "blocked";
  reason: string;
}

export interface SourceBrowserAgentResult {
  page: VacancySourcePage;
  state: import("../contracts.js").SourceBrowserAgentState;
  hasMore: boolean;
}
