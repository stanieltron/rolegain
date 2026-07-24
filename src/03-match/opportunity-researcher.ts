import path from "node:path";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import { CodexExecClient } from "../codex-runtime/client.js";
import { searchAndValidateOpportunities } from "../02-search/01-discovery/index.js";
import { revalidateOpportunities } from "../02-search/03-vacancy-validation/index.js";
import { matchOpportunities } from "./01-requirement-matching/index.js";
import { inspectOpportunityApplications } from "./02-application-inspection/index.js";
import { streamSearchToMatch } from "./orchestration/search-to-match-stream.js";
import { BrowserPool } from "../search-match-shared/browser-pool.js";
import type {
  OpportunityProgressReporter,
  OpportunityResearchProvider,
} from "../search-match-shared/types.js";

export interface OpportunityResearchResult {
  opportunities: JobOpportunity[];
  applications: ApplicationDraft[];
  failures: JobResearchFailure[];
  seenUrls: string[];
}

/**
 * Top-level opportunity-research facade.
 *
 * New work streams validated search vacancies directly into requirement
 * matching. Application inspection begins after the ranked match collection is
 * complete because it consumes the selected, stable set of matched vacancies.
 */
export class LiveOpportunityResearcher implements OpportunityResearchProvider {
  private readonly browsers = new BrowserPool();

  constructor(
    private readonly codex?: CodexExecClient,
    private readonly cwd = process.cwd(),
    private readonly dataRoot = path.join(this.cwd, "data"),
  ) {}

  cancelAll() {
    return this.browsers.cancelAll();
  }

  /** Run search, requirement matching, and form inspection. */
  async run(
    workspace: JobSearchWorkspace,
    options: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
    } = {},
  ): Promise<OpportunityResearchResult> {
    const research = await this.researchAndAssess(workspace, options);
    const inspection = research.opportunities.length
      ? await this.inspectApplications(
          workspace,
          research.opportunities,
          options.onProgress,
        )
      : { applications: [], failures: [] };
    return {
      opportunities: research.opportunities,
      applications: inspection.applications,
      failures: [...(research.failures ?? []), ...inspection.failures],
      seenUrls: research.seenUrls ?? [],
    };
  }

  research(
    workspace: JobSearchWorkspace,
    options: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
      onValidatedOpportunity?: (
        opportunity: JobOpportunity,
      ) => void | Promise<void>;
    } = {},
  ) {
    if (!this.codex) throw new Error("Codex live web search is not configured");
    return searchAndValidateOpportunities({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      browsers: this.browsers,
      workspace,
      options,
    });
  }

  researchAndAssess(
    workspace: JobSearchWorkspace,
    options: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
    } = {},
  ) {
    if (!this.codex) throw new Error("Codex live web search is not configured");
    return streamSearchToMatch({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      browsers: this.browsers,
      workspace,
      options,
    });
  }

  assess(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ) {
    return matchOpportunities({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      workspace,
      opportunities,
      onProgress,
    });
  }

  inspectApplications(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ) {
    return inspectOpportunityApplications({
      codex: this.codex,
      cwd: this.cwd,
      browsers: this.browsers,
      workspace,
      opportunities,
      onProgress,
    });
  }

  revalidate(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ) {
    if (!this.codex)
      return Promise.resolve({ opportunities, failures: [] });
    return revalidateOpportunities({
      codex: this.codex,
      cwd: this.cwd,
      browsers: this.browsers,
      workspace,
      opportunities,
      onProgress,
    });
  }
}
