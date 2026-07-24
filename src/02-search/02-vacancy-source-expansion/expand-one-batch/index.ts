import type { Browser } from "playwright";
import type { JobSearchWorkspace } from "../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../codex-runtime/client.js";
import {
  candidateFromListingLead,
  deterministicListingVacancyLeads,
  mergeListingLeads,
  repairVacancySnapshot,
} from "../../03-vacancy-validation/index.js";
import {
  extractVacancyLeadsFromListing,
  type VacancyPageSnapshot,
} from "../../03-vacancy-validation/interpreter.js";
import type { Phase2EvidenceContext } from "../../../search-match-shared/evidence-context.js";
import {
  canonicalOpportunityAlignment,
  canonicalOpportunityIsExcluded,
} from "../../../search-match-shared/evidence-context.js";
import { normalizeOpportunityUrl } from "../../../search-match-shared/opportunity.js";
import { discoveryWorkIntent } from "../../../search-match-shared/search-intent.js";
import type { LiveCandidate } from "../../../search-match-shared/types.js";
import type {
  SourceBrowserAgentState,
  VacancySourceCheckpoint,
} from "../contracts.js";
import { readVacancySourcePage } from "../page-reader/index.js";
import { runSourceBrowserAgent } from "../browser-agent/run/index.js";
import { shouldUseSourceBrowserAgent } from "../browser-agent/policy.js";

export interface ExpandOneSourceBatchInput {
  browser: Browser;
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  phase2Evidence: Phase2EvidenceContext;
  source: LiveCandidate;
  checkpoint: VacancySourceCheckpoint;
  pageUrl: string;
  batchSize?: number;
  navigateInteractiveSource?: typeof runSourceBrowserAgent;
}

export interface ExpandedSourceBatch {
  candidates: LiveCandidate[];
  nextUrl?: string;
  inspected: number;
  browserAgentState?: SourceBrowserAgentState;
  navigationError?: string;
}

/** Expand exactly one page/cursor from one persisted vacancy source. */
export async function expandOneVacancySourceBatch(
  input: ExpandOneSourceBatchInput,
): Promise<ExpandedSourceBatch> {
  const batchSize = Math.max(1, Math.min(50, input.batchSize ?? 20));
  let page = await readVacancySourcePage(input.browser, input.pageUrl);
  let browserAgentState: SourceBrowserAgentState | undefined;
  let browserAgentHasMore = false;
  let navigationError: string | undefined;
  if (shouldUseSourceBrowserAgent(page, batchSize)) {
    try {
      const navigated = await (
        input.navigateInteractiveSource ?? runSourceBrowserAgent
      )({
        browser: input.browser,
        codex: input.codex,
        cwd: input.cwd,
        pageUrl: input.pageUrl,
        sourceName: input.source.company || input.source.job.title,
        state: input.checkpoint.browserAgent,
        baselineUrls: page.links.map((link) => link.url),
        targetNewLinks: batchSize,
      });
      page = navigated.page;
      browserAgentState = navigated.state;
      browserAgentHasMore = navigated.hasMore;
    } catch (error) {
      navigationError = error instanceof Error ? error.message : String(error);
    }
  }
  const snapshot = repairVacancySnapshot({
    ...page,
    structured: emptyStructuredVacancy(),
  } satisfies VacancyPageSnapshot);
  const workIntent = discoveryWorkIntent(input.workspace);
  const intent = {
    location: workIntent.willingWorkLocations.join(" | "),
    workplace: workIntent.workplaceModes.join(", "),
    employmentTypes: input.workspace.profile.employmentTypes,
    skills: input.workspace.profile.skills,
    summary: input.workspace.profile.summary,
  };
  const interpreted = await extractVacancyLeadsFromListing(
    input.codex,
    input.cwd,
    snapshot,
    intent,
    batchSize,
  );
  const leads = mergeListingLeads(
    interpreted,
    deterministicListingVacancyLeads(snapshot, input.source.company, batchSize),
  ).slice(0, batchSize);
  const seen = new Set(
    input.checkpoint.seenVacancyUrls.map(normalizeOpportunityUrl),
  );
  const minimumAlignment = Math.max(
    0,
    Math.min(
      100,
      Number(process.env.ROLEGAIN_SOURCE_MIN_ALIGNMENT || 15),
    ),
  );
  const candidates = leads
    .map((lead) => candidateFromListingLead(input.source, lead, snapshot.pageUrl))
    .filter((candidate) => {
      const normalized = normalizeOpportunityUrl(candidate.job.jobUrl);
      if (seen.has(normalized)) return false;
      if (
        canonicalOpportunityIsExcluded(
          input.phase2Evidence,
          candidate.job.title,
        )
      )
        return false;
      candidate.preliminaryFit = canonicalOpportunityAlignment(
        input.phase2Evidence,
        {
          title: candidate.job.title,
          description: candidate.job.descriptionPlain,
        },
      );
      return candidate.preliminaryFit >= minimumAlignment;
    });
  return {
    candidates,
    nextUrl:
      page.nextUrl ||
      (browserAgentHasMore || navigationError ? input.pageUrl : undefined),
    inspected: leads.length,
    browserAgentState,
    navigationError,
  };
}

function emptyStructuredVacancy(): VacancyPageSnapshot["structured"] {
  return {
    hasJobPosting: false,
    title: "",
    company: "",
    location: "",
    workplaceType: "",
    employmentType: "",
    description: "",
    datePosted: "",
    validThrough: "",
    applyUrl: "",
  };
}
