import type { Browser } from "playwright";
import type { JobSearchWorkspace } from "../../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../../codex-runtime/client.js";
import type { LiveCandidate } from "../../../../search-match-shared/types.js";
import { resolveDiscoveredJobs } from "../index.js";

export interface ValidateOneVacancyInput {
  browser: Browser;
  candidate: LiveCandidate;
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  expansionLimit?: number;
}

/**
 * Validate one discovered lead from a frozen browser acquisition. A list-page
 * lead may return several independently validated concrete vacancies.
 */
export function validateOneVacancy(
  input: ValidateOneVacancyInput,
): Promise<LiveCandidate[]> {
  return resolveDiscoveredJobs(
    input.browser,
    input.candidate,
    input.codex,
    input.cwd,
    input.workspace,
    input.expansionLimit ?? 1,
  );
}
