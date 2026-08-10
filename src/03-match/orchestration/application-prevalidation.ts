import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import {
  mapParallelOrdered,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import { failureFromOpportunity } from "../../search-match-shared/opportunity.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import type { OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { findReachableApplicationForm } from "../02-application-inspection/index.js";

/**
 * Match-stage gate that cheaply confirms a reachable employer application
 * route before spending model calls on requirement matching. It does not read,
 * map, fill, or verify form fields; those remain application-preparation work
 * and run only after ranking and portfolio selection.
 */
export async function prevalidateOpportunitiesForMatching(input: {
  codex?: CodexExecClient;
  cwd: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
  onProgress?: OpportunityProgressReporter;
}) {
  const { codex, cwd, browsers, workspace, opportunities, onProgress } = input;
  const executionGeneration = browsers.currentGeneration(workspace.candidateId);
  const browser = await browsers.launch.bind(browsers)(
    workspace.candidateId,
    executionGeneration,
  );
  try {
    const results = await mapParallelOrdered(
      opportunities,
      vacancyValidationConcurrency(),
      async (opportunity) => {
        const item = progressItemFromOpportunity(opportunity);
        await onProgress?.({
          item,
          phase: "match",
          state: "running",
          activity: `Prevalidating the employer application route for ${opportunity.company} · ${opportunity.title} before evidence matching.`,
        });
        try {
          const applicationUrl = await findReachableApplicationForm(
            browser,
            opportunity.applyUrl,
            codex,
            cwd,
          );
          const viable = { ...opportunity, applyUrl: applicationUrl };
          await onProgress?.({
            item: progressItemFromOpportunity(viable),
            phase: "match",
            // The job remains active in Match & rank. Only the subsequent
            // requirement assessment is allowed to mark matching as passed.
            state: "running",
            activity: `Application route prevalidated for ${viable.company} · ${viable.title}; starting evidence matching.`,
          });
          return { opportunity: viable };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await onProgress?.({
            item,
            phase: "match",
            state: "failed",
            reason,
            activity: `Match prevalidation stopped for ${opportunity.company} · ${opportunity.title}: ${reason}`,
          });
          return {
            failure: failureFromOpportunity(
              opportunity,
              "match_prevalidation",
              reason,
            ),
          };
        }
      },
    );
    return {
      opportunities: results
        .map((item) => item.opportunity)
        .filter((item): item is JobOpportunity => Boolean(item)),
      failures: results
        .map((item) => item.failure)
        .filter((item): item is JobResearchFailure => Boolean(item)),
    };
  } finally {
    await browsers.close(browser);
  }
}
