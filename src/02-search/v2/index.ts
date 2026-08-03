import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
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
import {
  captureSearchV2Leads,
  extractSignals,
} from "./harness/capture.js";
import {
  classifySearchV2Captures,
  discoverSearchV2Leads,
} from "./harness/model.js";
import {
  canonicalVacancyIdentity,
  compensationRatesFor,
  matchesSearchV2Workplace,
  meetsSearchV2CompensationFloor,
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
    (options.excludeApplyUrls ?? []).map(normalizeOpportunityUrl),
  );
  const opportunities: JobOpportunity[] = [];
  const failures: JobResearchFailure[] = [];
  const captures: SearchV2Capture[] = [];
  const decisions: SearchV2Decision[] = [];
  const waves: SearchV2WaveAudit[] = [];
  const identities = new Set<string>();
  const rejectionFeedback: string[] = [];
  let lowYieldWaves = 0;
  const rates = await compensationRatesFor(workspace).catch(() => ({ EUR: 1 }));

  await options.onProgress?.({
    activity: `Search v2 is finding and concurrently checking public pages for ${target} strong vacancies.`,
  });
  try {
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

      const childLeads: SearchV2Lead[] = [];
      let expandedChildren = 0;
      for (let index = 0; index < waveCaptures.length; index += 1) {
        const capture = waveCaptures[index];
        const decision = waveDecisions[index];
        if (decision.status === "vacancy") {
          await acceptVacancy({
            capture,
            decision,
            workspace,
            evidence,
            searchRunId,
            target,
            rates,
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
          rejectionFeedback.push(decision.reason);
          await options.onProgress?.({
            item: progressItem(capture.lead),
            phase: "validation",
            state: "failed",
            reason: decision.reason,
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
        const children = deduplicateChildren(decision.children).slice(
          0,
          configuration.childrenPerSource,
        );
        expandedChildren += children.length;
        await options.onProgress?.({
          item: progressItem(capture.lead),
          phase: "validation",
          state: "bench",
          reason: children.length
            ? `Expanded this source into ${children.length} concrete vacancies`
            : "No concrete child vacancy was visible on this source",
          validationDisposition: "source_page",
        });
        await options.onProgress?.({
          activity: `${sourceGroup.name} contains ${children.length} concrete role${children.length === 1 ? "" : "s"}; validating the children now.`,
        });
        for (const child of children) {
          const childLead: SearchV2Lead = {
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
          };
          const samePage =
            normalizeOpportunityUrl(child.url) ===
            normalizeOpportunityUrl(capture.finalUrl || capture.suppliedUrl);
          if (samePage) {
            const childCapture = cloneCaptureForChild(capture, childLead);
            captures.push(childCapture);
            const childDecision: SearchV2Decision = {
              id: childLead.id,
              status: "vacancy",
              reason: "The list classifier extracted this concrete role from the current source page.",
              title: child.title,
              company: child.company || capture.lead.company,
              location: decision.location,
              workplaceType: decision.workplaceType,
              employmentType: decision.employmentType,
              applyUrl: child.url,
              compensation: decision.compensation,
              children: [],
            };
            decisions.push(childDecision);
            await acceptVacancy({
              capture: childCapture,
              decision: childDecision,
              workspace,
              evidence,
              searchRunId,
              target,
              rates,
              opportunities,
              failures,
              identities,
              onProgress: options.onProgress,
              onValidatedOpportunity: options.onValidatedOpportunity,
            });
          } else if (!seen.has(normalizeOpportunityUrl(child.url))) {
            seen.add(normalizeOpportunityUrl(child.url));
            childLeads.push(childLead);
          }
        }
      }

      if (childLeads.length && opportunities.length < target) {
        await Promise.all(
          childLeads.map((lead) =>
            options.onProgress?.({
              item: progressItem(lead),
              phase: "validation",
              state: "waiting",
            }),
          ),
        );
        const childCaptures = await captureSearchV2Leads({
          browser,
          leads: childLeads,
          configuration,
        });
        captures.push(...childCaptures);
        const childDecisions = await classifySearchV2Captures({
          codex,
          cwd,
          captures: childCaptures,
          configuration,
        });
        decisions.push(...childDecisions);
        for (let index = 0; index < childCaptures.length; index += 1) {
          const capture = childCaptures[index];
          const decision = childDecisions[index];
          if (decision.status === "vacancy")
            await acceptVacancy({
              capture,
              decision,
              workspace,
              evidence,
              searchRunId,
              target,
              rates,
              opportunities,
              failures,
              identities,
              onProgress: options.onProgress,
              onValidatedOpportunity: options.onValidatedOpportunity,
            });
          else {
            const reason =
              decision.status === "job_list"
                ? "Nested list source was not expanded beyond one bounded level"
                : decision.reason;
            const failure = searchV2Failure(capture.lead, reason);
            failures.push(failure);
            rejectionFeedback.push(reason);
            await options.onProgress?.({
              item: progressItem(capture.lead),
              phase: "validation",
              state: "failed",
              reason,
              validationDisposition: failure.disposition,
            });
          }
        }
      }

      const validated = opportunities.length - before;
      lowYieldWaves = validated === 0 ? lowYieldWaves + 1 : 0;
      waves.push({
        wave: wave + 1,
        leads: leads.length,
        captures: waveCaptures.length,
        vacancies: waveDecisions.filter((item) => item.status === "vacancy").length,
        jobLists: waveDecisions.filter((item) => item.status === "job_list").length,
        rejected: waveDecisions.filter((item) => item.status === "reject").length,
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
  return Math.min(requested, Math.max(4, Math.ceil(applications * 2.6)));
}

async function acceptVacancy(input: {
  capture: SearchV2Capture;
  decision: SearchV2Decision;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  searchRunId: string;
  target: number;
  rates: Record<string, number>;
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
  else if (
    !meetsSearchV2CompensationFloor(
      opportunity,
      input.workspace,
      input.rates,
    )
  )
    failureReason =
      "Published compensation does not satisfy the candidate's confirmed floor";
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

function cloneCaptureForChild(
  capture: SearchV2Capture,
  lead: SearchV2Lead,
): SearchV2Capture {
  const cloned = { ...capture, id: lead.id, lead };
  return { ...cloned, signals: extractSignals(cloned) };
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
