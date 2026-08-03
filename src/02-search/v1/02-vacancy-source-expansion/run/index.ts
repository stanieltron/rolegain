import type { Browser } from "playwright";
import type { JobSearchWorkspace } from "../../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../../codex-runtime/client.js";
import type { Phase2EvidenceContext } from "../../../../search-match-shared/evidence-context.js";
import type { LiveCandidate } from "../../../../search-match-shared/types.js";
import { normalizeOpportunityUrl } from "../../../../search-match-shared/opportunity.js";
import { expandOneVacancySourceBatch } from "../expand-one-batch/index.js";
import {
  VacancySourceInventory,
  checkpointNeedsHeadRefresh,
} from "../inventory/index.js";

export interface RunVacancySourceInput {
  browser: Browser;
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  phase2Evidence: Phase2EvidenceContext;
  inventory: VacancySourceInventory;
  source: LiveCandidate;
  targetCandidates?: number;
  maxPages?: number;
  shouldContinue?: () => boolean;
  onCandidate?: (candidate: LiveCandidate) => void | Promise<void>;
  expandBatch?: typeof expandOneVacancySourceBatch;
}

/**
 * Refresh and continue one persisted vacancy source. The function emits
 * concrete child leads and checkpoints after every page.
 */
export async function runVacancySource(
  input: RunVacancySourceInput,
): Promise<LiveCandidate[]> {
  const checkpoint = await input.inventory.register(input.source);
  const targetCandidates = Math.max(
    1,
    Math.min(100, input.targetCandidates ?? 12),
  );
  const maxPages = Math.max(
    1,
    Math.min(
      20,
      input.maxPages ??
        Number(process.env.ROLEGAIN_SOURCE_MAX_PAGES_PER_RUN || 3),
    ),
  );
  const emitted: LiveCandidate[] = [];
  let pagesThisRun = 0;
  let navigationBlockedThisRun = false;

  checkpoint.pendingVacancies ??= [];
  const emitCandidate = async (candidate: LiveCandidate) => {
    candidate.job.sourceGroup ??= {
      id: `source-${checkpoint.sourceId}`,
      name: checkpoint.sourceName,
      url: checkpoint.sourceUrl,
      sourceClass: checkpoint.sourceClass,
    };
    const normalized = normalizeOpportunityUrl(candidate.job.jobUrl);
    if (
      checkpoint.seenVacancyUrls.some(
        (url) => normalizeOpportunityUrl(url) === normalized,
      )
    )
      return false;
    await input.onCandidate?.(candidate);
    emitted.push(candidate);
    checkpoint.seenVacancyUrls.push(candidate.job.jobUrl);
    checkpoint.vacanciesEmitted += 1;
    return true;
  };

  const processPage = async (pageUrl: string, mode: "head" | "frontier") => {
    const batch = await (input.expandBatch ?? expandOneVacancySourceBatch)({
      browser: input.browser,
      codex: input.codex,
      cwd: input.cwd,
      workspace: input.workspace,
      phase2Evidence: input.phase2Evidence,
      source: input.source,
      checkpoint,
      pageUrl,
      batchSize: Math.min(50, Math.max(20, targetCandidates * 3)),
    });
    pagesThisRun += 1;
    checkpoint.pagesInspected += 1;
    checkpoint.vacanciesInspected += batch.inspected;
    if (batch.browserAgentState)
      checkpoint.browserAgent = batch.browserAgentState;
    const known = new Set([
      ...checkpoint.seenVacancyUrls.map(normalizeOpportunityUrl),
      ...checkpoint.pendingVacancies.map((candidate) =>
        normalizeOpportunityUrl(candidate.job.jobUrl),
      ),
    ]);
    for (const candidate of batch.candidates) {
      const normalized = normalizeOpportunityUrl(candidate.job.jobUrl);
      if (known.has(normalized)) continue;
      known.add(normalized);
      if (emitted.length < targetCandidates) await emitCandidate(candidate);
      else checkpoint.pendingVacancies.push(candidate);
    }
    checkpoint.seenVacancyUrls = checkpoint.seenVacancyUrls.slice(-20_000);
    const now = new Date().toISOString();
    checkpoint.lastSynchronizedAt = now;
    checkpoint.lastError = batch.navigationError;
    if (
      mode === "head" ||
      normalizeOpportunityUrl(pageUrl) ===
        normalizeOpportunityUrl(checkpoint.sourceUrl)
    )
      checkpoint.lastHeadRefreshAt = now;
    if (mode === "frontier") {
      checkpoint.cursorUrl = batch.nextUrl || checkpoint.cursorUrl;
      checkpoint.hasMore = Boolean(batch.nextUrl);
    }
    navigationBlockedThisRun ||= Boolean(batch.navigationError);
    await input.inventory.save(checkpoint);
  };

  try {
    const refreshHead = checkpointNeedsHeadRefresh(checkpoint);
    const newSource = checkpoint.pagesInspected === 0;
    if (refreshHead && pagesThisRun < maxPages) {
      await processPage(checkpoint.sourceUrl, newSource ? "frontier" : "head");
    }
    while (
      checkpoint.pendingVacancies.length > 0 &&
      emitted.length < targetCandidates
    ) {
      const candidate = checkpoint.pendingVacancies.shift()!;
      await emitCandidate(candidate);
    }
    if (emitted.length >= targetCandidates) {
      await input.inventory.save(checkpoint);
      return emitted;
    }
    while (
      emitted.length < targetCandidates &&
      pagesThisRun < maxPages &&
      checkpoint.hasMore &&
      !navigationBlockedThisRun &&
      (input.shouldContinue?.() ?? true)
    ) {
      await processPage(checkpoint.cursorUrl, "frontier");
    }
    return emitted;
  } catch (error) {
    checkpoint.lastError = error instanceof Error ? error.message : String(error);
    checkpoint.lastSynchronizedAt = new Date().toISOString();
    await input.inventory.save(checkpoint);
    throw error;
  }
}
