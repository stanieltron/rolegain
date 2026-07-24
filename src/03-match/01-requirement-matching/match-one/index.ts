import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../codex-runtime/client.js";
import { assessOpportunityWithAgent } from "../index.js";

export interface MatchOneOpportunityInput {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  opportunity: JobOpportunity;
  /** Explicit eval/inspection override; production continues to use configured defaults. */
  model?: string;
}

/** Run the complete per-job match and reverse-verification chain. */
export function matchOneOpportunity(
  input: MatchOneOpportunityInput,
): Promise<{
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
}> {
  return assessOpportunityWithAgent(
    input.codex,
    input.cwd,
    input.dataRoot,
    input.workspace,
    input.opportunity,
    input.model,
  );
}
