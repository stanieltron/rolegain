import path from "node:path";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import { CodexExecClient } from "../codex-runtime/client.js";
import type { MatchVersion, SearchVersion } from "../config/runtime.js";
import {
  searchImplementationFor,
  type SearchImplementation,
} from "../search-discovery.js";
import { revalidateOpportunities } from "../02-search/v1/03-vacancy-validation/index.js";
import { matchOpportunitiesV1 } from "./v1/index.js";
import { matchOpportunitiesV2 } from "./v2/index.js";
import {
  inspectOpportunityApplications,
} from "./02-application-inspection/index.js";
import { streamSearchToMatch } from "./orchestration/search-to-match-stream.js";
import { prevalidateOpportunitiesForMatching } from "./orchestration/application-prevalidation.js";
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
  private readonly search: SearchImplementation;
  private readonly match: typeof matchOpportunitiesV1;
  private readonly matchVersion: MatchVersion;

  constructor(
    private readonly codex?: CodexExecClient,
    private readonly cwd = process.cwd(),
    private readonly dataRoot = path.join(this.cwd, "data"),
    searchVersion: SearchVersion = process.env.ROLEGAIN_SEARCH_VERSION === "v2"
      ? "v2"
      : "v1",
    matchVersion: MatchVersion = process.env.ROLEGAIN_MATCH_VERSION === "v2"
      ? "v2"
      : "v1",
  ) {
    this.search = searchImplementationFor(searchVersion);
    this.match = matchVersion === "v2"
      ? matchOpportunitiesV2
      : matchOpportunitiesV1;
    this.matchVersion = matchVersion;
  }

  cancelAll() {
    return this.browsers.cancelAll();
  }

  cancel(candidateId: string) {
    return this.browsers.cancel(candidateId);
  }

  /** Run search, match-stage route prevalidation, matching, then form inspection. */
  async run(
    workspace: JobSearchWorkspace,
    options: {
      excludeApplyUrls?: string[];
      limit?: number;
      onProgress?: OpportunityProgressReporter;
    } = {},
  ): Promise<OpportunityResearchResult> {
    const research = await this.research(workspace, options);
    const viability = research.opportunities.length
      ? await this.prevalidateForMatching(
          workspace,
          research.opportunities,
          options.onProgress,
        )
      : { opportunities: [], failures: [] };
    const assessment = viability.opportunities.length
      ? await this.assess(workspace, viability.opportunities, options.onProgress)
      : { opportunities: [], failures: [] };
    const matched = Array.isArray(assessment)
      ? { opportunities: assessment, failures: [] }
      : assessment;
    const inspection = matched.opportunities.length
      ? await this.inspectApplications(
          workspace,
          matched.opportunities,
          options.onProgress,
        )
      : { applications: [], failures: [] };
    return {
      opportunities: matched.opportunities,
      applications: inspection.applications,
      failures: [
        ...(research.failures ?? []),
        ...viability.failures,
        ...matched.failures,
        ...inspection.failures,
      ],
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
    return this.search({
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
      onMatchedOpportunity?: (
        opportunity: JobOpportunity,
      ) => void | Promise<void>;
    } = {},
  ) {
    if (!this.codex) throw new Error("Codex live web search is not configured");
    return streamSearchToMatch({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      browsers: this.browsers,
      workspace,
      search: this.search,
      matchVersion: this.matchVersion,
      options,
    });
  }

  assess(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ) {
    return this.match({
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

  prevalidateForMatching(
    workspace: JobSearchWorkspace,
    opportunities: JobOpportunity[],
    onProgress?: OpportunityProgressReporter,
  ) {
    return prevalidateOpportunitiesForMatching({
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
    options?: { expansionLimit?: number },
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
      expansionLimit: options?.expansionLimit,
    });
  }
}
