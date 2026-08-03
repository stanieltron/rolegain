import type { CodexExecClient } from "../../codex-runtime/client.js";
import type {
  JobOpportunity,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { matchOpportunities } from "../shared/01-requirement-matching/index.js";

export type MatchV1Input = Omit<Parameters<typeof matchOpportunities>[0], "version">;

export interface MatchOneV1Input {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  opportunity: JobOpportunity;
  model?: string;
}
