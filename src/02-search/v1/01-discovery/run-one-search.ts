import type { JobSearchWorkspace } from "../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../codex-runtime/client.js";
import type { Phase2EvidenceContext } from "../../../search-match-shared/evidence-context.js";
import type { LiveCandidate } from "../../../search-match-shared/types.js";
import { discoverWebJobsWithAgent } from "./index.js";

export interface OneSearchInput {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  phase2Evidence: Phase2EvidenceContext;
  requested: number;
  alreadyFoundUrls?: string[];
  rejectionFeedback?: string[];
  waveNumber?: number;
}

/** Execute exactly one inspectable web-discovery call. */
export function runOneSearch(input: OneSearchInput): Promise<LiveCandidate[]> {
  return discoverWebJobsWithAgent(
    input.codex,
    input.cwd,
    input.workspace,
    input.alreadyFoundUrls ?? [],
    input.requested,
    input.phase2Evidence,
    input.rejectionFeedback ?? [],
    input.waveNumber ?? 0,
  );
}
