import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { searchAndValidateOpportunities } from "../../02-search/01-discovery/index.js";
import { matchOneOpportunity } from "../01-requirement-matching/match-one/index.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import { matchingConcurrency } from "../../search-match-shared/parallel.js";
import { failureFromOpportunity } from "../../search-match-shared/opportunity.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import type { OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { runBoundedStreamingPipeline } from "./streaming-pipeline.js";

export interface SearchToMatchStreamInput {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  options?: {
    excludeApplyUrls?: string[];
    limit?: number;
    onProgress?: OpportunityProgressReporter;
    onMatchedOpportunity?: (
      opportunity: JobOpportunity,
    ) => void | Promise<void>;
  };
}

interface MatchTerminalResult {
  opportunity?: JobOpportunity;
  failures: JobResearchFailure[];
}

/** Search, validate, match, and reverse-verify without cross-stage barriers. */
export async function streamSearchToMatch(input: SearchToMatchStreamInput) {
  const onProgress = input.options?.onProgress;
  const streamed = await runBoundedStreamingPipeline<
    JobOpportunity,
    MatchTerminalResult,
    Awaited<ReturnType<typeof searchAndValidateOpportunities>>
  >({
    concurrency: matchingConcurrency(),
    key: (opportunity) => opportunity.id,
    produce: (emit) =>
      searchAndValidateOpportunities({
        codex: input.codex,
        cwd: input.cwd,
        dataRoot: input.dataRoot,
        browsers: input.browsers,
        workspace: input.workspace,
        options: {
          ...input.options,
          onValidatedOpportunity: emit,
        },
      }),
    consume: async (opportunity) => {
      await onProgress?.({
        item: progressItemFromOpportunity(opportunity),
        phase: "match",
        state: "running",
      });
      try {
        const matched = await matchOneOpportunity({
          codex: input.codex,
          cwd: input.cwd,
          dataRoot: input.dataRoot,
          workspace: input.workspace,
          opportunity,
        });
        const verified = matched.opportunities[0];
        const failures = matched.failures;
        await onProgress?.({
          item: progressItemFromOpportunity(opportunity),
          phase: "match",
          state: verified ? "passed" : "failed",
          fit: verified?.fit,
          reason: failures[0]?.reason,
        });
        return { opportunity: verified, failures };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await onProgress?.({
          item: progressItemFromOpportunity(opportunity),
          phase: "match",
          state: "failed",
          reason,
        });
        return {
          failures: [failureFromOpportunity(opportunity, "requirements", reason)],
        };
      }
    },
    onCompleted: async (_opportunity, result) => {
      if (result.opportunity)
        await input.options?.onMatchedOpportunity?.(result.opportunity);
    },
  });

  const matched = streamed.results.flatMap((result) =>
    result.opportunity ? [result.opportunity] : [],
  );
  return {
    opportunities: matched.sort((left, right) => right.fit - left.fit),
    applications: [],
    failures: [
      ...(streamed.producerResult.failures ?? []),
      ...streamed.results.flatMap((result) => result.failures),
    ],
    seenUrls: streamed.producerResult.seenUrls,
  };
}
