import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import type { Browser } from "playwright";
import {
  mapParallelOrdered,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import type { OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { findReachableApplicationForm } from "../02-application-inspection/index.js";

export async function prevalidateOneOpportunityForMatching(input: {
  browser: Browser;
  codex?: CodexExecClient;
  cwd: string;
  opportunity: JobOpportunity;
  onProgress?: OpportunityProgressReporter;
}): Promise<{
  opportunity?: JobOpportunity;
  deferredOpportunity?: JobOpportunity;
  failure?: JobResearchFailure;
}> {
  const { browser, codex, cwd, opportunity, onProgress } = input;
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
    const viable: JobOpportunity = {
      ...opportunity,
      applyUrl: applicationUrl,
      applicationRoute: { status: "verified" },
    };
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
    const deferredOpportunity: JobOpportunity = {
      ...opportunity,
      applicationRoute: { status: "manual_review", reason },
    };
    await onProgress?.({
      item: progressItemFromOpportunity(deferredOpportunity),
      phase: "match",
      state: "bench",
      activity: `Employer form could not be prevalidated for ${opportunity.company} · ${opportunity.title}; retained for deferred evidence matching and possible manual application.`,
    });
    return { deferredOpportunity };
  }
}

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
  onPrevalidatedOpportunity?: (opportunity: JobOpportunity) => void;
}) {
  const {
    codex,
    cwd,
    browsers,
    workspace,
    opportunities,
    onProgress,
    onPrevalidatedOpportunity,
  } = input;
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
        const result = await prevalidateOneOpportunityForMatching({
          browser,
          codex,
          cwd,
          opportunity,
          onProgress,
        });
        if (result.opportunity)
          onPrevalidatedOpportunity?.(result.opportunity);
        return result;
      },
    );
    return {
      opportunities: results
        .map((item) => item.opportunity)
        .filter((item): item is JobOpportunity => Boolean(item)),
      deferredOpportunities: results
        .map((item) => item.deferredOpportunity)
        .filter((item): item is JobOpportunity => Boolean(item)),
      failures: results
        .map((item) => item.failure)
        .filter((item): item is JobResearchFailure => Boolean(item)),
    };
  } finally {
    await browsers.close(browser);
  }
}
