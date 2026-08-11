import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
  SearchSourceBacklogItem,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import {
  loadPhase2EvidenceContext,
  type Phase2EvidenceContext,
} from "../../search-match-shared/evidence-context.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import type { OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { searchV2Configuration } from "./config.js";
import type {
  SearchV2Capture,
  SearchV2Decision,
  SearchV2Lead,
  SearchV2WaveAudit,
} from "./contracts.js";
import { captureSearchV2Leads } from "./harness/capture.js";
import {
  classifySearchV2Captures,
  discoverSearchV2Leads,
} from "./harness/model.js";
import {
  canonicalVacancyIdentity,
  matchesSearchV2Workplace,
  opportunityFromSearchV2,
  searchV2Failure,
} from "./support/opportunity.js";
import { normalizeOpportunityUrl } from "./support/url.js";

export interface SearchV2Input {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  options?: {
    excludeApplyUrls?: string[];
    limit?: number;
    onProgress?: OpportunityProgressReporter;
    onValidatedOpportunity?: (
      opportunity: JobOpportunity,
    ) => void | Promise<void>;
  };
}

/** Independent capture-first discovery v2 entry point. */
export async function searchAndValidateOpportunitiesV2(input: SearchV2Input) {
  const { codex, cwd, dataRoot, browsers, workspace } = input;
  const options = input.options ?? {};
  const configuration = searchV2Configuration();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  const target = validatedDiscoveryTargetV2(
    limit,
    workspace.searchConfig.applicationTarget,
  );
  workspace.searchSourceBacklog ??= [];
  if (!workspace.searchSourceBacklogInitialized) {
    const recovered = await recoverSearchSourceBacklog({
      dataRoot,
      candidateId: workspace.candidateId,
      workspace,
      childrenPerSource: configuration.childrenPerSource,
    });
    workspace.searchSourceBacklog = mergeSearchSourceBacklog(
      workspace.searchSourceBacklog,
      recovered,
    );
    workspace.searchSourceBacklogInitialized = true;
  }
  workspace.searchSourceBacklog = workspace.searchSourceBacklog.filter(
    (item) => !knownSearchSourceKeys(workspace).has(searchSourceKey(item)),
  );
  const evidence = await loadPhase2EvidenceContext(dataRoot, workspace);
  if (!evidence)
    throw new Error(
      "A canonical evidence run is required before search v2 and matching",
    );
  const startedAt = new Date().toISOString();
  const searchRunId = `search-v2-${createHash("sha256")
    .update(`${workspace.candidateId}:${startedAt}`)
    .digest("hex")
    .slice(0, 20)}`;
  const generation = browsers.currentGeneration(workspace.candidateId);
  const browser = await browsers.launch(workspace.candidateId, generation);
  const seen = new Set(
    [
      ...workspace.seenJobUrls,
      ...workspace.searchSourceBacklog.map((item) => item.sourceUrl),
      ...(options.excludeApplyUrls ?? []),
    ].map(normalizeOpportunityUrl),
  );
  const opportunities: JobOpportunity[] = [];
  const failures: JobResearchFailure[] = [];
  const captures: SearchV2Capture[] = [];
  const decisions: SearchV2Decision[] = [];
  const waves: SearchV2WaveAudit[] = [];
  const identities = new Set<string>();
  const attemptedBacklogKeys = new Set<string>();
  const rejectionFeedback: string[] = [];
  let lowYieldWaves = 0;

  await options.onProgress?.({
    activity: `Search v2 is finding and concurrently checking public pages for ${target} strong vacancies.`,
  });
  try {
    if (workspace.searchSourceBacklog.length) {
      const available = workspace.searchSourceBacklog.length;
      await options.onProgress?.({
        activity: `Reusing ${Math.min(target, available)} of ${available} saved or retryable vacancies before running another web search.`,
      });
      await validateSearchSourceBacklog({
        codex,
        cwd,
        browser,
        configuration,
        workspace,
        evidence,
        searchRunId,
        target,
        maxItems: target,
        opportunities,
        failures,
        captures,
        decisions,
        identities,
        attemptedBacklogKeys,
        onProgress: options.onProgress,
        onValidatedOpportunity: options.onValidatedOpportunity,
      });
    }
    for (
      let wave = 0;
      wave < configuration.maxWaves && opportunities.length < target;
      wave += 1
    ) {
      const waveStarted = Date.now();
      const before = opportunities.length;
      const requested = Math.min(
        50,
        Math.max(24, (target - opportunities.length) * 3),
      );
      let leads: SearchV2Lead[];
      try {
        leads = await discoverSearchV2Leads({
          codex,
          cwd,
          workspace,
          evidence,
          requested,
          wave,
          excludedUrls: [...seen],
          rejectionFeedback,
        });
      } catch (error) {
        if (!opportunities.length) throw error;
        await options.onProgress?.({
          activity: `Search v2 wave ${wave + 1} stopped early; continuing with ${opportunities.length} validated vacancies.`,
        });
        break;
      }
      leads = leads.filter((lead) => {
        const key = normalizeOpportunityUrl(lead.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await Promise.all(
        leads.map((lead) =>
          options.onProgress?.({
            item: progressItem(lead),
            phase: "validation",
            state: "waiting",
          }),
        ),
      );
      await options.onProgress?.({
        activity: `Search v2 found ${leads.length} new pages. Capturing them concurrently before one-pass classification.`,
      });
      const waveCaptures = await captureSearchV2Leads({
        browser,
        leads,
        configuration,
      });
      captures.push(...waveCaptures);
      const waveDecisions = await classifySearchV2Captures({
        codex,
        cwd,
        captures: waveCaptures,
        configuration,
      });
      decisions.push(...waveDecisions);
      const vacancyCount = waveDecisions.filter(
        (item) => item.status === "vacancy",
      ).length;
      const listCount = waveDecisions.filter(
        (item) => item.status === "job_list",
      ).length;
      const rejectedCount = waveDecisions.filter(
        (item) => item.status === "reject",
      ).length;
      await options.onProgress?.({
        activity: `Search wave ${wave + 1} classified ${waveDecisions.length} captured pages: ${vacancyCount} concrete vacancies, ${listCount} job lists to expand, and ${rejectedCount} rejected pages.`,
      });

      let expandedChildren = 0;
      for (let index = 0; index < waveCaptures.length; index += 1) {
        const capture = waveCaptures[index];
        const decision = waveDecisions[index];
        if (decision.status === "vacancy") {
          if (opportunities.length >= target) {
            workspace.searchSourceBacklog = mergeSearchSourceBacklog(
              workspace.searchSourceBacklog,
              [backlogItemFromLead(capture.lead)],
            );
            await options.onProgress?.({
              item: progressItem(capture.lead),
              phase: "validation",
              state: "bench",
              reason:
                "Current validation target reached; saved for the next application batch",
            });
            continue;
          }
          await acceptVacancy({
            capture,
            decision,
            workspace,
            evidence,
            searchRunId,
            target,
            opportunities,
            failures,
            identities,
            onProgress: options.onProgress,
            onValidatedOpportunity: options.onValidatedOpportunity,
          });
          continue;
        }
        if (decision.status === "reject") {
          const failure = searchV2Failure(capture.lead, decision.reason);
          failures.push(failure);
          if (isRetryableSearchFailure(failure))
            workspace.searchSourceBacklog = mergeSearchSourceBacklog(
              workspace.searchSourceBacklog,
              [backlogItemFromLead(capture.lead, 1)],
            );
          if (!isRetryableSearchFailure(failure))
            rejectionFeedback.push(decision.reason);
          await options.onProgress?.({
            item: progressItem(capture.lead),
            phase: "validation",
            state: isRetryableSearchFailure(failure) ? "bench" : "failed",
            reason: isRetryableSearchFailure(failure)
              ? `${decision.reason}; saved for another validation attempt`
              : decision.reason,
            validationDisposition: failure.disposition,
          });
          continue;
        }

        const sourceGroup = {
          id: `source-v2-${capture.id}`,
          name: capture.lead.company || decision.company || "Vacancy source",
          url: capture.finalUrl || capture.suppliedUrl,
          sourceClass: capture.lead.sourceClass || "employer_directory",
        };
        const children = deduplicateChildren(decision.children)
          .filter(
            (child) =>
              normalizeOpportunityUrl(child.url) !==
              normalizeOpportunityUrl(sourceGroup.url),
          )
          .slice(0, configuration.childrenPerSource);
        expandedChildren += children.length;
        const childLeads = children.map((child): SearchV2Lead => ({
          id: createHash("sha256")
            .update(`${capture.id}:${child.title}:${child.url}`)
            .digest("hex")
            .slice(0, 20),
          title: child.title,
          company: child.company || capture.lead.company,
          location: capture.lead.location,
          workplaceType: capture.lead.workplaceType,
          employmentType: capture.lead.employmentType,
          url: child.url,
          sourceKind: "vacancy",
          query: capture.lead.query,
          sourceClass: capture.lead.sourceClass,
          snippet: "",
          compensation: "",
          wave: capture.lead.wave,
          sourceGroup,
        }));
        const beforeQueue = workspace.searchSourceBacklog.length;
        workspace.searchSourceBacklog = mergeSearchSourceBacklog(
          workspace.searchSourceBacklog,
          childLeads.map(backlogItemFromLead),
          knownSearchSourceKeys(workspace, opportunities),
        );
        const saved = workspace.searchSourceBacklog.length - beforeQueue;
        for (const child of childLeads)
          seen.add(normalizeOpportunityUrl(child.url));
        await options.onProgress?.({
          item: progressItem(capture.lead),
          phase: "validation",
          state: "bench",
          reason: children.length
            ? `Found ${children.length} concrete vacancies; ${saved} new ${saved === 1 ? "vacancy is" : "vacancies are"} saved for bounded validation now or in the next batch`
            : "No concrete child vacancy was visible on this source",
          validationDisposition: "source_page",
        });
        await options.onProgress?.({
          activity: children.length
            ? `${sourceGroup.name} exposed ${children.length} concrete role${children.length === 1 ? "" : "s"}. The current batch will validate only the vacancies it still needs; the rest remain saved for “next 5”.`
            : `${sourceGroup.name} did not expose a concrete vacancy that could be saved.`,
        });
      }

      if (
        workspace.searchSourceBacklog.length &&
        opportunities.length < target
      )
        await validateSearchSourceBacklog({
          codex,
          cwd,
          browser,
          configuration,
          workspace,
          evidence,
          searchRunId,
          target,
          maxItems: target - opportunities.length,
          opportunities,
          failures,
          captures,
          decisions,
          identities,
          attemptedBacklogKeys,
          onProgress: options.onProgress,
          onValidatedOpportunity: options.onValidatedOpportunity,
          rejectionFeedback,
        });

      const validated = opportunities.length - before;
      lowYieldWaves = validated === 0 ? lowYieldWaves + 1 : 0;
      waves.push({
        wave: wave + 1,
        leads: leads.length,
        captures: waveCaptures.length,
        vacancies: waveDecisions.filter((item) => item.status === "vacancy")
          .length,
        jobLists: waveDecisions.filter((item) => item.status === "job_list")
          .length,
        rejected: waveDecisions.filter((item) => item.status === "reject")
          .length,
        expandedChildren,
        validated,
        durationMs: Date.now() - waveStarted,
      });
      if (lowYieldWaves >= 2) break;
      if (opportunities.length < target)
        await options.onProgress?.({
          activity: `${opportunities.length} vacancies are validated. Search v2 is starting another focused wave for the remaining ${target - opportunities.length}.`,
        });
    }
  } finally {
    await browsers.close(browser);
  }

  opportunities.sort((left, right) => right.fit - left.fit);
  const uniqueFailures = deduplicateFailures(failures);
  await persistSearchV2Audit({
    dataRoot,
    candidateId: workspace.candidateId,
    searchRunId,
    startedAt,
    completedAt: new Date().toISOString(),
    target,
    configuration,
    waves,
    captures,
    decisions,
    opportunities,
    failures: uniqueFailures,
  });
  await options.onProgress?.({
    activity: `Search v2 completed ${waves.length} ${waves.length === 1 ? "wave" : "waves"}: ${opportunities.length} live vacancies verified and ${uniqueFailures.length} pages excluded or left unresolved.`,
  });
  return {
    opportunities,
    applications: [],
    failures: uniqueFailures,
    seenUrls: [...seen],
  };
}

export function validatedDiscoveryTargetV2(
  requestedVacancies: number,
  applicationTarget: number,
) {
  const requested = Math.max(1, Math.floor(requestedVacancies));
  const applications = Math.max(1, Math.floor(applicationTarget));
  // Search must absorb losses from application-route prevalidation and match
  // thresholds. Closed, duplicate and list pages never count toward this live
  // vacancy target.
  return Math.min(requested, Math.max(8, Math.ceil(applications * 5.2)));
}

async function validateSearchSourceBacklog(input: {
  codex: CodexExecClient;
  cwd: string;
  browser: Awaited<ReturnType<BrowserPool["launch"]>>;
  configuration: ReturnType<typeof searchV2Configuration>;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  searchRunId: string;
  target: number;
  maxItems: number;
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
  captures: SearchV2Capture[];
  decisions: SearchV2Decision[];
  identities: Set<string>;
  attemptedBacklogKeys: Set<string>;
  onProgress?: OpportunityProgressReporter;
  onValidatedOpportunity?: (
    opportunity: JobOpportunity,
  ) => void | Promise<void>;
  rejectionFeedback?: string[];
}) {
  const prioritized = prioritizeSearchSourceBacklog(
    input.workspace.searchSourceBacklog!,
    input.evidence,
  ).filter(
    (item) => !input.attemptedBacklogKeys.has(searchSourceKey(item)),
  );
  const count = Math.max(
    0,
    Math.min(
      Math.floor(input.maxItems),
      input.target - input.opportunities.length,
      prioritized.length,
    ),
  );
  if (!count) return;
  const selected = prioritized.slice(0, count);
  const selectedKeys = new Set(selected.map(searchSourceKey));
  for (const key of selectedKeys) input.attemptedBacklogKeys.add(key);
  input.workspace.searchSourceBacklog =
    input.workspace.searchSourceBacklog!.filter(
      (item) => !selectedKeys.has(searchSourceKey(item)),
    );
  const leads = selected.map(leadFromBacklogItem);
  try {
    await Promise.all(
      leads.map((lead) =>
        input.onProgress?.({
          item: progressItem(lead),
          phase: "validation",
          state: "waiting",
        }),
      ),
    );
    const backlogCaptures = await captureSearchV2Leads({
      browser: input.browser,
      leads,
      configuration: input.configuration,
    });
    input.captures.push(...backlogCaptures);
    const classified = backlogCaptures.length
      ? await classifySearchV2Captures({
          codex: input.codex,
          cwd: input.cwd,
          captures: backlogCaptures,
          configuration: input.configuration,
        })
      : [];
    const classifiedById = new Map(classified.map((item) => [item.id, item]));
    for (const capture of backlogCaptures) {
      const decision = classifiedById.get(capture.id);
      if (!decision)
        throw new Error(`Search v2 did not classify queued vacancy ${capture.id}`);
      input.decisions.push(decision);
      if (decision.status === "vacancy") {
        await acceptVacancy({
          capture,
          decision,
          workspace: input.workspace,
          evidence: input.evidence,
          searchRunId: input.searchRunId,
          target: input.target,
          opportunities: input.opportunities,
          failures: input.failures,
          identities: input.identities,
          onProgress: input.onProgress,
          onValidatedOpportunity: input.onValidatedOpportunity,
        });
        continue;
      }
      const reason =
        decision.status === "job_list"
          ? "The saved vacancy resolved to another list page instead of an individual vacancy"
          : decision.reason;
      const failure = searchV2Failure(capture.lead, reason);
      input.failures.push(failure);
      const previous = selected.find(
        (item) => searchSourceKey(item) === searchSourceKey(capture.lead),
      );
      const attempts = (previous?.attempts ?? 0) + 1;
      if (previous && attempts < 3 && isRetryableSearchFailure(failure))
        input.workspace.searchSourceBacklog = mergeSearchSourceBacklog(
          input.workspace.searchSourceBacklog ?? [],
          [{ ...previous, attempts }],
        );
      if (!isRetryableSearchFailure(failure))
        input.rejectionFeedback?.push(reason);
      await input.onProgress?.({
        item: progressItem(capture.lead),
        phase: "validation",
        state: isRetryableSearchFailure(failure) ? "bench" : "failed",
        reason: isRetryableSearchFailure(failure)
          ? `${reason}; saved for another validation attempt`
          : reason,
        validationDisposition: failure.disposition,
      });
    }
    await input.onProgress?.({
      activity: `${selected.length} saved vacancies were checked; ${input.workspace.searchSourceBacklog.length} remain available for a later batch or retry.`,
    });
  } catch (error) {
    input.workspace.searchSourceBacklog = mergeSearchSourceBacklog(
      selected,
      input.workspace.searchSourceBacklog ?? [],
    );
    throw error;
  }
}

function backlogItemFromLead(
  lead: SearchV2Lead,
  attempts = 0,
): SearchSourceBacklogItem {
  return {
    id: lead.id,
    title: lead.title,
    company: lead.company,
    location: lead.location,
    workplaceType: lead.workplaceType,
    employmentType: lead.employmentType,
    sourceUrl: lead.url,
    query: lead.query,
    sourceClass: lead.sourceClass,
    snippet: lead.snippet,
    compensation: lead.compensation,
    wave: lead.wave,
    sourceGroup: lead.sourceGroup,
    discoveredAt: new Date().toISOString(),
    attempts,
  };
}

function leadFromBacklogItem(item: SearchSourceBacklogItem): SearchV2Lead {
  return {
    id: item.id,
    title: item.title,
    company: item.company,
    location: item.location,
    workplaceType: item.workplaceType,
    employmentType: item.employmentType,
    url: item.sourceUrl,
    sourceKind: "vacancy",
    query: item.query,
    sourceClass: item.sourceClass,
    snippet: item.snippet,
    compensation: item.compensation,
    wave: item.wave,
    sourceGroup: item.sourceGroup,
  };
}

export function mergeSearchSourceBacklog(
  existing: SearchSourceBacklogItem[],
  incoming: SearchSourceBacklogItem[],
  excluded = new Set<string>(),
) {
  const merged: SearchSourceBacklogItem[] = [];
  const seen = new Set(excluded);
  for (const item of [...existing, ...incoming]) {
    const key = searchSourceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function prioritizeSearchSourceBacklog(
  items: SearchSourceBacklogItem[],
  evidence: Pick<Phase2EvidenceContext, "searchLanes">,
) {
  const phrases = evidence.searchLanes.flatMap((lane) => [
    lane.canonicalTitle,
    ...lane.titleAliases,
  ]).map((value) => value.toLowerCase());
  const vocabulary = new Set(
    evidence.searchLanes.flatMap((lane) => [
      lane.canonicalTitle,
      ...lane.titleAliases,
      ...lane.leadingCapabilities,
      ...lane.toolsMethods,
    ]).flatMap(searchTitleTokens),
  );
  return items
    .map((item, index) => {
      const title = item.title.toLowerCase();
      const tokens = searchTitleTokens(title);
      const exact = phrases.reduce(
        (score, phrase) => score + (title.includes(phrase) ? 12 : 0),
        0,
      );
      const overlap = tokens.reduce(
        (score, token) => score + (vocabulary.has(token) ? 2 : 0),
        0,
      );
      return { item, index, score: exact + overlap };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

function searchTitleTokens(value: string) {
  const ignored = new Set([
    "and", "the", "for", "with", "senior", "lead", "staff", "remote",
    "engineer", "engineering", "developer", "development", "software",
  ]);
  return value
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function searchSourceKey(
  item: SearchSourceBacklogItem | SearchV2Lead | {
    title: string;
    company: string;
    sourceUrl: string;
  },
) {
  const url = "sourceUrl" in item ? item.sourceUrl : item.url;
  return `${item.title.trim().toLowerCase()}::${normalizeOpportunityUrl(url)}`;
}

function knownSearchSourceKeys(
  workspace: JobSearchWorkspace,
  current: JobOpportunity[] = [],
) {
  const completedHistory = workspace.jobHistory.filter(
    (item) =>
      item.validation === "passed" ||
      item.match === "passed" ||
      item.application === "passed" ||
      item.application === "selected" ||
      item.validationDisposition === "duplicate" ||
      item.validationDisposition === "source_page",
  );
  const terminalFailures = [
    ...workspace.rejectedOpportunities,
    ...workspace.searchValidationIssues,
  ].filter((failure) => {
    const normalized = searchV2Failure(
      {
        id: failure.id,
        title: failure.title,
        company: failure.company,
        location: failure.location,
        workplaceType: "",
        employmentType: "",
        url: failure.sourceUrl,
        sourceKind: "vacancy",
        query: "",
        sourceClass: "",
        snippet: "",
        compensation: "",
        wave: 0,
      },
      failure.reason,
    );
    return normalized.disposition === "rejected" ||
      normalized.disposition === "duplicate";
  });
  return new Set(
    [
      ...completedHistory,
      ...workspace.opportunities,
      ...workspace.searchReadyOpportunities,
      ...terminalFailures,
      ...current,
    ].map((item) =>
      searchSourceKey({
        title: item.title,
        company: item.company,
        sourceUrl: item.sourceUrl,
      }),
    ),
  );
}

function isRetryableSearchFailure(failure: JobResearchFailure) {
  return (
    failure.disposition !== "rejected" &&
    failure.disposition !== "duplicate" &&
    failure.disposition !== "source_page"
  );
}

export async function recoverSearchSourceBacklog(input: {
  dataRoot: string;
  candidateId: string;
  workspace: JobSearchWorkspace;
  childrenPerSource: number;
}) {
  const root = path.join(
    input.dataRoot,
    "job-search",
    "runs",
    input.candidateId,
    "search-v2-runs",
  );
  let runNames: string[];
  try {
    runNames = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") runNames = [];
    else throw error;
  }
  const recovered: SearchSourceBacklogItem[] = [];
  for (const runName of runNames.sort()) {
    const runRoot = path.join(root, runName);
    let captures: SearchV2Capture[];
    let decisions: SearchV2Decision[];
    try {
      [captures, decisions] = await Promise.all([
        readJsonLines<SearchV2Capture>(path.join(runRoot, "captures.jsonl")),
        readJsonLines<SearchV2Decision>(path.join(runRoot, "decisions.jsonl")),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const capturesById = new Map(captures.map((capture) => [capture.id, capture]));
    for (const decision of decisions) {
      if (decision.status !== "job_list") continue;
      const capture = capturesById.get(decision.id);
      if (!capture) continue;
      const sourceGroup = {
        id: `source-v2-${capture.id}`,
        name: capture.lead.company || decision.company || "Vacancy source",
        url: capture.finalUrl || capture.suppliedUrl,
        sourceClass: capture.lead.sourceClass || "employer_directory",
      };
      const children = deduplicateChildren(decision.children).slice(
        0,
        input.childrenPerSource,
      );
      for (const child of children) {
        if (
          normalizeOpportunityUrl(child.url) ===
          normalizeOpportunityUrl(sourceGroup.url)
        )
          continue;
        recovered.push(
          backlogItemFromLead({
            id: createHash("sha256")
              .update(`${capture.id}:${child.title}:${child.url}`)
              .digest("hex")
              .slice(0, 20),
            title: child.title,
            company: child.company || capture.lead.company,
            location: decision.location || capture.lead.location,
            workplaceType:
              decision.workplaceType || capture.lead.workplaceType,
            employmentType:
              decision.employmentType || capture.lead.employmentType,
            url: child.url,
            sourceKind: "vacancy",
            query: capture.lead.query,
            sourceClass: capture.lead.sourceClass,
            snippet: "",
            compensation: decision.compensation,
            wave: capture.lead.wave,
            sourceGroup,
          }),
        );
      }
    }
  }
  const auditBacklog = mergeSearchSourceBacklog(
    [],
    recovered,
    knownSearchSourceKeys(input.workspace),
  );
  const validationOutcomes = [
    ...input.workspace.rejectedOpportunities,
    ...input.workspace.searchValidationIssues,
  ];
  const retryableHistory = input.workspace.jobHistory
    .filter(
      (item) =>
        item.validation !== "passed" &&
        item.match !== "passed" &&
        item.validationDisposition !== "source_page" &&
        item.validationDisposition !== "duplicate" &&
        /^https?:\/\//i.test(item.sourceUrl),
    )
    .map((item) => {
      const outcome = validationOutcomes.find(
        (candidate) =>
          candidate.id === item.id ||
          (candidate.title === item.title &&
            normalizeOpportunityUrl(candidate.sourceUrl) ===
              normalizeOpportunityUrl(item.sourceUrl)),
      );
      const lead: SearchV2Lead = {
        id: item.id,
        title: item.title,
        company: item.company,
        location: outcome?.location || "Not specified",
        workplaceType: input.workspace.profile.workplace,
        employmentType: "",
        url: item.sourceUrl,
        sourceKind: "vacancy",
        query: "Retry a previously discovered vacancy with improved page recovery",
        sourceClass: "retry_backlog",
        snippet: "",
        compensation: "",
        wave: 0,
        sourceGroup: item.sourceGroup,
      };
      const failure = searchV2Failure(
        lead,
        item.reason || outcome?.reason || "Unresolved vacancy validation",
      );
      return isRetryableSearchFailure(failure)
        ? backlogItemFromLead(lead)
        : undefined;
    })
    .filter((item): item is SearchSourceBacklogItem => Boolean(item));
  return mergeSearchSourceBacklog(auditBacklog, retryableHistory);
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  const value = await readFile(file, "utf8");
  return value
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

async function acceptVacancy(input: {
  capture: SearchV2Capture;
  decision: SearchV2Decision;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  searchRunId: string;
  target: number;
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
  identities: Set<string>;
  onProgress?: OpportunityProgressReporter;
  onValidatedOpportunity?: (
    opportunity: JobOpportunity,
  ) => void | Promise<void>;
}) {
  if (input.opportunities.length >= input.target) {
    await input.onProgress?.({
      item: progressItem(input.capture.lead),
      phase: "validation",
      state: "bench",
      reason: "Validation target reached; this vacancy can be reconsidered in a later run",
    });
    return;
  }
  const opportunity = opportunityFromSearchV2(input);
  let failureReason = "";
  if (!matchesSearchV2Workplace(opportunity, input.workspace))
    failureReason = "Workplace or location does not match the candidate constraint";
  const identity = canonicalVacancyIdentity(opportunity);
  if (!failureReason && input.identities.has(identity))
    failureReason = "Duplicate of an already validated vacancy";
  if (failureReason) {
    const failure = searchV2Failure(input.capture.lead, failureReason);
    input.failures.push(failure);
    await input.onProgress?.({
      item: progressItem(input.capture.lead),
      phase: "validation",
      state: "failed",
      reason: failureReason,
      validationDisposition: failure.disposition,
    });
    return;
  }
  input.identities.add(identity);
  input.opportunities.push(opportunity);
  await input.onProgress?.({
    item: progressItem(input.capture.lead),
    phase: "validation",
    state: "passed",
  });
  await input.onValidatedOpportunity?.(opportunity);
}

function progressItem(lead: SearchV2Lead) {
  return {
    id: lead.id,
    company: lead.company || "Unknown employer",
    title: lead.title || "Unknown position",
    sourceUrl: lead.url,
    sourceGroup: lead.sourceGroup,
  };
}

function deduplicateChildren(children: SearchV2Decision["children"]) {
  const seen = new Set<string>();
  return children.filter((child) => {
    const key = `${child.title.toLowerCase()}::${normalizeOpportunityUrl(child.url)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateFailures(failures: JobResearchFailure[]) {
  const byKey = new Map<string, JobResearchFailure>();
  for (const failure of failures)
    byKey.set(
      `${normalizeOpportunityUrl(failure.sourceUrl)}:${failure.stage}`,
      failure,
    );
  return [...byKey.values()];
}

async function persistSearchV2Audit(input: {
  dataRoot: string;
  candidateId: string;
  searchRunId: string;
  startedAt: string;
  completedAt: string;
  target: number;
  configuration: ReturnType<typeof searchV2Configuration>;
  waves: SearchV2WaveAudit[];
  captures: SearchV2Capture[];
  decisions: SearchV2Decision[];
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
}) {
  const root = path.join(
    input.dataRoot,
    "job-search",
    "runs",
    input.candidateId,
    "search-v2-runs",
    input.searchRunId,
  );
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify(
        {
          version: "v2",
          searchRunId: input.searchRunId,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          target: input.target,
          configuration: input.configuration,
          counts: {
            captures: input.captures.length,
            decisions: input.decisions.length,
            opportunities: input.opportunities.length,
            failures: input.failures.length,
          },
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(path.join(root, "waves.jsonl"), jsonLines(input.waves), "utf8"),
    writeFile(
      path.join(root, "captures.jsonl"),
      jsonLines(input.captures),
      "utf8",
    ),
    writeFile(
      path.join(root, "decisions.jsonl"),
      jsonLines(input.decisions),
      "utf8",
    ),
    writeFile(
      path.join(root, "opportunities.jsonl"),
      jsonLines(input.opportunities),
      "utf8",
    ),
    writeFile(
      path.join(root, "failures.jsonl"),
      jsonLines(input.failures),
      "utf8",
    ),
  ]);
}

function jsonLines(values: unknown[]) {
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}
