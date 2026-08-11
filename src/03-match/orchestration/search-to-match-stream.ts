import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { MatchVersion } from "../../config/runtime.js";
import {
  searchImplementationFor,
  type SearchImplementation,
} from "../../search-discovery.js";
import { matchOneOpportunityV1 } from "../v1/index.js";
import { matchOneOpportunityV2 } from "../v2/index.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import {
  matchingConcurrency,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import { failureFromOpportunity } from "../../search-match-shared/opportunity.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import type { OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { prevalidateOneOpportunityForMatching } from "./application-prevalidation.js";
import { runBoundedTwoStageStreamingPipeline } from "./streaming-pipeline.js";

export interface SearchToMatchStreamInput {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  search?: SearchImplementation;
  matchVersion?: MatchVersion;
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

/**
 * Search, validate, application-route prevalidate, match, and reverse-verify
 * without cross-stage barriers.
 */
export async function streamSearchToMatch(input: SearchToMatchStreamInput) {
  const onProgress = input.options?.onProgress;
  const search = input.search ?? searchImplementationFor(
    process.env.ROLEGAIN_SEARCH_VERSION === "v2" ? "v2" : "v1",
  );
  const matchOne = (input.matchVersion ?? (
    process.env.ROLEGAIN_MATCH_VERSION === "v2" ? "v2" : "v1"
  )) === "v2"
    ? matchOneOpportunityV2
    : matchOneOpportunityV1;
  const executionGeneration = input.browsers.currentGeneration(
    input.workspace.candidateId,
  );
  let browserPromise: ReturnType<BrowserPool["launch"]> | undefined;
  const deferredOpportunities: JobOpportunity[] = [];
  let streamed!: {
    producerResult: Awaited<ReturnType<SearchImplementation>>;
    results: MatchTerminalResult[];
  };
  try {
    streamed = await runBoundedTwoStageStreamingPipeline<
      JobOpportunity,
      JobOpportunity,
      MatchTerminalResult,
      Awaited<ReturnType<SearchImplementation>>
    >({
      firstConcurrency: vacancyValidationConcurrency(),
      secondConcurrency: matchingConcurrency(),
      key: (opportunity) => opportunity.id,
      produce: (emit) =>
        search({
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
      first: async (opportunity) => {
        browserPromise ??= input.browsers.launch(
          input.workspace.candidateId,
          executionGeneration,
        );
        const prevalidated = await prevalidateOneOpportunityForMatching({
          browser: await browserPromise,
          codex: input.codex,
          cwd: input.cwd,
          opportunity,
          onProgress,
        });
        if (prevalidated.deferredOpportunity)
          deferredOpportunities.push(prevalidated.deferredOpportunity);
        return prevalidated.opportunity;
      },
      second: async (opportunity) => {
        await onProgress?.({
          item: progressItemFromOpportunity(opportunity),
          phase: "match",
          state: "running",
        });
        try {
          const matched = await matchOne({
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
            activity: verified
              ? `${verified.company} · ${verified.title}: assessed ${verified.requirementMatches.length} employer requirements, retained ${verified.strengths.length} evidence-backed strengths and ${verified.gaps.length} visible gaps; final fit ${verified.fit}%.`
              : undefined,
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
            failures: [
              failureFromOpportunity(opportunity, "requirements", reason),
            ],
          };
        }
      },
      onCompleted: async (_opportunity, result) => {
        if (result.opportunity)
          await input.options?.onMatchedOpportunity?.(result.opportunity);
      },
    });
  } finally {
    const browser = await browserPromise?.catch(() => undefined);
    if (browser) await input.browsers.close(browser).catch(() => undefined);
  }

  const matched = streamed.results.flatMap((result) =>
    result.opportunity ? [result.opportunity] : [],
  );
  return {
    opportunities: matched.sort((left, right) => right.fit - left.fit),
    deferredOpportunities,
    applications: [],
    failures: [
      ...(streamed.producerResult.failures ?? []),
      ...streamed.results.flatMap((result) => result.failures),
    ],
    seenUrls: streamed.producerResult.seenUrls,
  };
}
