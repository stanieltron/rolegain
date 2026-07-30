import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobOpportunity, JobResearchFailure, JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { productionModel } from "../../codex-runtime/call-manifest.js";
import {
  buildInput as buildWebSearchInput,
  command as WEB_SEARCH_COMMAND,
  outputSchema as webSearchOutputSchema,
  rolePrompt as WEB_SEARCH_ROLE_PROMPT,
  type WebSearchOutput,
} from "./llm-calls/01-web-search/index.js";
import { normalizeExtractedText, repairMojibake } from "../../infrastructure/text-encoding.js";
import {
  canonicalOpportunityAlignment,
  canonicalOpportunityIsExcluded,
  canonicalStrengthsForTitle,
  loadPhase2EvidenceContext,
  phase2DiscoveryPacket,
  phase2ActiveSearchLanes,
  phase2QueryPortfolio,
  type Phase2EvidenceContext,
} from "../../search-match-shared/evidence-context.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import {
  authoritativeSourceConfidence,
  canonicalVacancyIdentity,
  calculateOpportunityConfidence,
  currentEurExchangeRates,
  deduplicateFailures,
  evidenceGaps,
  extractCompensation,
  extractQualificationSection,
  extractRequirements,
  extractResponsibilitiesSection,
  isPublicWebUrl,
  matchesWorkplace,
  meetsCompensationFloor,
  normalizeCompensationText,
  normalizeOpportunityUrl,
  researchFailure,
  summarize,
  validationRiskSignals,
} from "../../search-match-shared/opportunity.js";
import { resolveDiscoveredJobs } from "../03-vacancy-validation/index.js";
import { progressItem } from "../../search-match-shared/progress.js";
import { discoveryWorkIntent } from "../../search-match-shared/search-intent.js";
import {
  mapParallelOrdered,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import type { DiscoveredJob, LiveCandidate, OpportunityProgressReporter } from "../../search-match-shared/types.js";
import { classifySearchLead } from "../02-vacancy-source-expansion/contracts.js";
import {
  VacancySourceInventory,
  checkpointAsCandidate,
  checkpointNeedsHeadRefresh,
} from "../02-vacancy-source-expansion/inventory/index.js";
import { runVacancySource } from "../02-vacancy-source-expansion/run/index.js";
import { BoundedExecutor } from "../../03-match/orchestration/bounded-executor.js";

export async function searchAndValidateOpportunities(input: {
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
}) {
  const { codex, cwd, dataRoot, browsers, workspace } = input;
  const options = input.options ?? {};
    const executionGeneration = browsers.currentGeneration(workspace.candidateId);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const validatedTarget = validatedDiscoveryTarget(
      limit,
      workspace.searchConfig.applicationTarget,
    );
    const maxSearchWaves = Math.max(
      1,
      Math.min(6, Number(process.env.ROLEGAIN_MAX_SEARCH_WAVES || 6)),
    );
    const phase2Evidence = await loadPhase2EvidenceContext(
      dataRoot,
      workspace,
    );
    if (!phase2Evidence)
      throw new Error(
        "A canonical evidence run is required before search and matching",
      );
    const vacancySourceInventory = new VacancySourceInventory(
      dataRoot,
      workspace.candidateId,
    );
    const searchStartedAt = new Date().toISOString();
    const searchRunId = `search-${createHash("sha256")
      .update(`${workspace.candidateId}:${searchStartedAt}`)
      .digest("hex")
      .slice(0, 20)}`;
    const excluded = new Set(
      (options.excludeApplyUrls ?? []).map(normalizeOpportunityUrl),
    );
    if (!codex)
      throw new Error("Codex live web search is not configured");
    await options.onProgress?.({
      activity: searchActivity(workspace, limit, phase2Evidence),
    });
    const discoverySize = Math.min(
      50,
      Math.max(validatedTarget + 8, validatedTarget * 2),
    );
    const heartbeatMessages = [
      "The search agent is checking public job boards and employer career pages.",
      "Still searching; location constraints and jobs with existing applications remain excluded.",
      "Collecting vacancy links and job facts for independent validation.",
    ];
    let heartbeatIndex = 0;
    const heartbeat = setInterval(() => {
      const activity = heartbeatMessages[heartbeatIndex % heartbeatMessages.length];
      heartbeatIndex += 1;
      void Promise.resolve(options.onProgress?.({ activity })).catch(() => undefined);
    }, 6000);
    let initialCandidates: LiveCandidate[];
    let exchangeRates: Awaited<ReturnType<typeof currentEurExchangeRates>>;
    try {
      [initialCandidates, exchangeRates] = await Promise.all([
        discoverWebJobsWithAgent(
          codex,
          cwd,
          workspace,
          options.excludeApplyUrls ?? [],
          discoverySize,
          phase2Evidence,
          [],
          0,
        ),
        currentEurExchangeRates(),
      ]);
    } finally {
      clearInterval(heartbeat);
    }
    const savedSources = (await vacancySourceInventory.list())
      .filter(
        (checkpoint) =>
          checkpoint.hasMore || checkpointNeedsHeadRefresh(checkpoint),
      )
      .map(checkpointAsCandidate);
    initialCandidates = mergeSearchCandidates(
      initialCandidates,
      savedSources,
    );
    const browser = await browsers.launch.bind(browsers)(
      workspace.candidateId,
      executionGeneration,
    );
    const opportunities: JobOpportunity[] = [];
    const inspectionErrors: string[] = [];
    const failures: JobResearchFailure[] = [];
    const inspectedUrls = new Set(excluded);
    const seenUrls = new Set(options.excludeApplyUrls ?? []);
    const resolvedVacancies = new Set<string>();
    const waveRecords: Array<Record<string, unknown>> = [];
    let consecutiveLowYield = 0;
    try {
      let candidates = initialCandidates;
      await options.onProgress?.({
        activity: `Found ${initialCandidates.length} possible vacancies. Verifying every source in parallel.`,
      });
      await Promise.all(
        initialCandidates
          .filter(
            (candidate) => classifySearchLead(candidate).kind === "vacancy",
          )
          .map((candidate) =>
          options.onProgress?.({
            item: progressItem(candidate),
            phase: "validation",
            state: "waiting",
          }),
          ),
      );
      for (
        let wave = 0;
        wave < maxSearchWaves && opportunities.length < validatedTarget;
        wave += 1
      ) {
        const opportunitiesBefore = opportunities.length;
        const failuresBefore = failures.length;
        const eligibleCandidates = candidates.filter((candidate) => {
          seenUrls.add(candidate.job.jobUrl);
          seenUrls.add(candidate.job.applyUrl);
          const normalized = normalizeOpportunityUrl(candidate.job.applyUrl);
          if (inspectedUrls.has(normalized)) return false;
          inspectedUrls.add(normalized);
          return true;
        });
        const directLeadCount = eligibleCandidates.filter(
          (candidate) => classifySearchLead(candidate).kind === "vacancy",
        ).length;
        const sourceLeadCount = eligibleCandidates.length - directLeadCount;
        const sourceCandidateBudget = Math.max(
          5,
          Math.ceil(validatedTarget * 0.5),
          Math.max(0, validatedTarget - directLeadCount) * 3,
        );
        const candidatesPerSource = Math.max(
          1,
          Math.min(
            20,
            Math.ceil(sourceCandidateBudget / Math.max(1, sourceLeadCount)),
          ),
        );
        await mapParallelOrdered(
          eligibleCandidates,
          vacancyValidationConcurrency(),
          async (candidate) => {
              if (opportunities.length >= validatedTarget) return;
              const lead = classifySearchLead(candidate);
              if (lead.kind === "vacancy")
                await options.onProgress?.({
                  item: progressItem(candidate),
                  phase: "validation",
                  state: "running",
                });
              else
                await options.onProgress?.({
                  activity: `Expanding saved vacancy source ${candidate.company || candidate.job.jobUrl}.`,
                });
              try {
                const resolved =
                  lead.kind === "vacancy"
                    ? await resolveDiscoveredJobs(
                        browser,
                        candidate,
                        codex,
                        cwd,
                        workspace,
                        1,
                      )
                    : await validateVacanciesWhileExpandingSource({
                        browser,
                        codex,
                        cwd,
                        workspace,
                        phase2Evidence,
                        inventory: vacancySourceInventory,
                        source: candidate,
                        targetCandidates: candidatesPerSource,
                        shouldContinue: () =>
                          opportunities.length < validatedTarget * 2,
                        onProgress: options.onProgress,
                      });
                if (lead.kind === "vacancy")
                  await options.onProgress?.({
                    item: progressItem(candidate),
                    phase: "validation",
                    state: resolved.length ? "passed" : "failed",
                    reason: resolved.length
                      ? undefined
                      : "No current vacancy was found at this source",
                    validationDisposition: resolved.length
                      ? undefined
                      : "unresolved",
                  });
                else
                  await options.onProgress?.({
                    activity: `${candidate.company || "Vacancy source"} emitted ${resolved.length} independently validated vacancies.`,
                  });
                for (const resolvedCandidate of resolved) {
                  if (opportunities.length >= validatedTarget) break;
                  const vacancyKey = canonicalVacancyIdentity(resolvedCandidate);
                  if (resolvedVacancies.has(vacancyKey)) {
                    const failure = researchFailure(
                      resolvedCandidate,
                      "vacancy_validation",
                      "Duplicate of an already validated vacancy",
                    );
                    failures.push(failure);
                    await options.onProgress?.({
                      item: progressItem(resolvedCandidate),
                      phase: "validation",
                      state: "failed",
                      reason: failure.reason,
                      validationDisposition: failure.disposition,
                    });
                    continue;
                  }
                  resolvedVacancies.add(vacancyKey);
                  seenUrls.add(resolvedCandidate.job.jobUrl);
                  seenUrls.add(resolvedCandidate.job.applyUrl);
                  const compensation =
                    normalizeCompensationText(
                      resolvedCandidate.job.compensation || "",
                    ) ||
                    extractCompensation(
                      resolvedCandidate.job.descriptionPlain || "",
                    );
                  if (
                    !meetsCompensationFloor(
                      compensation,
                      workspace,
                      exchangeRates,
                    )
                  ) {
                    const failure = researchFailure(
                      resolvedCandidate,
                      "vacancy_validation",
                      "Published compensation does not satisfy the candidate's confirmed floor",
                    );
                    failures.push(failure);
                    await options.onProgress?.({
                      item: progressItem(resolvedCandidate),
                      phase: "validation",
                      state: "failed",
                      reason: failure.reason,
                      validationDisposition: failure.disposition,
                    });
                    continue;
                  }
                  if (!matchesWorkplace(resolvedCandidate.job, workspace)) {
                    const failure = researchFailure(
                      resolvedCandidate,
                      "vacancy_validation",
                      "Workplace or location does not match the candidate constraint",
                    );
                    failures.push(failure);
                    await options.onProgress?.({
                      item: progressItem(resolvedCandidate),
                      phase: "validation",
                      state: "failed",
                      reason: failure.reason,
                      validationDisposition: failure.disposition,
                    });
                    continue;
                  }
                  const description = (
                    resolvedCandidate.job.descriptionPlain || ""
                  ).trim();
                  const validatedAt = new Date().toISOString();
                  const sourceConfidence = authoritativeSourceConfidence(
                    resolvedCandidate.job.jobUrl,
                    resolvedCandidate.job.applyUrl,
                  );
                  const riskSignals = validationRiskSignals(
                    resolvedCandidate.job,
                  );
                  const opportunityConfidence = calculateOpportunityConfidence({
                    sourceConfidence,
                    hasApplicationPath:
                      normalizeOpportunityUrl(resolvedCandidate.job.applyUrl) !==
                        normalizeOpportunityUrl(resolvedCandidate.job.jobUrl) ||
                      /\/application|\/apply\b/i.test(
                        resolvedCandidate.job.applyUrl,
                      ),
                    descriptionComplete: description.length >= 500,
                    statusConsistent: resolvedCandidate.job.isListed !== false,
                    hasPublishedDate: Boolean(resolvedCandidate.job.publishedAt),
                    riskSignalCount: riskSignals.length,
                  });
                  const opportunity: JobOpportunity = {
                    id: `live-${resolvedCandidate.job.id}`,
                    evidenceRunId: phase2Evidence.evidenceRunId,
                    searchRunId,
                    company: resolvedCandidate.company,
                    title: resolvedCandidate.job.title,
                    location:
                      resolvedCandidate.job.location || "Not specified",
                    workplace:
                      resolvedCandidate.job.workplaceType ||
                      (resolvedCandidate.job.isRemote
                        ? "Remote"
                        : "Not specified"),
                    compensation: compensation || "Not disclosed",
                    sourceUrl: resolvedCandidate.job.jobUrl,
                    applyUrl: resolvedCandidate.job.applyUrl,
                    capturedAt: validatedAt.slice(0, 10),
                    lastValidatedAt: validatedAt,
                    fit: resolvedCandidate.preliminaryFit,
                    summary: summarize(description),
                    description,
                    requirements: extractRequirements(description),
                    requirementMatches: [],
                    strengths: canonicalStrengthsForTitle(
                      phase2Evidence,
                      resolvedCandidate.job.title,
                    ),
                    gaps: evidenceGaps(workspace, description),
                    opportunityConfidence,
                    validation: {
                      status: "live",
                      sourceConfidence,
                      retrievedAt: validatedAt,
                      descriptionFingerprint: createHash("sha256")
                        .update(description)
                        .digest("hex"),
                      responsibilitiesText:
                        extractResponsibilitiesSection(description),
                      qualificationsText:
                        extractQualificationSection(description),
                      riskSignals,
                    },
                    discoveryProvenance: [
                      {
                        query:
                          resolvedCandidate.job.discoveryQuery ||
                          "unrecorded discovery query",
                        wave: resolvedCandidate.job.discoveryWave || wave + 1,
                        sourceClass:
                          resolvedCandidate.job.sourceClass || "search_engine",
                        discoveredAt: validatedAt,
                      },
                    ],
                  };
                  opportunities.push(opportunity);
                  await options.onProgress?.({
                    item: progressItem(resolvedCandidate),
                    phase: "validation",
                    state: "passed",
                  });
                  await options.onValidatedOpportunity?.(opportunity);
                }
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                inspectionErrors.push(`${candidate.company} ${candidate.job.title}: ${reason}`);
                const failure = researchFailure(candidate, "vacancy_validation", reason);
                failures.push(failure);
                await options.onProgress?.({
                  item: progressItem(candidate),
                  phase: "validation",
                  state: "failed",
                  reason,
                  validationDisposition: failure.disposition,
                });
              }
          },
        );
        const newValidatedJobs = opportunities.length - opportunitiesBefore;
        consecutiveLowYield = newValidatedJobs === 0 ? consecutiveLowYield + 1 : 0;
        const duplicateCount = Math.max(0, candidates.length - eligibleCandidates.length);
        waveRecords.push({
          wave: wave + 1,
          hypothesis: phase2QueryPortfolio(phase2Evidence, wave, 4),
          leadsFound: candidates.length,
          uniqueEmployers: new Set(candidates.map((item) => item.company.toLowerCase())).size,
          validatedLiveJobs: newValidatedJobs,
          validationFailures: failures.length - failuresBefore,
          duplicateRate:
            candidates.length === 0 ? 0 : duplicateCount / candidates.length,
          sourceClasses: [
            ...new Set(
              candidates.map((item) => item.job.sourceClass || "search_engine"),
            ),
          ],
          nextDecision:
            opportunities.length >= validatedTarget
              ? "target_reached"
              : consecutiveLowYield >= 2
                ? "saturated_after_repeated_low_yield"
                : wave >= maxSearchWaves - 1
                  ? "wave_budget_exhausted"
                  : "continue_undercovered_cells",
        });
        if (
          opportunities.length < validatedTarget &&
          consecutiveLowYield < 2 &&
          wave < maxSearchWaves - 1
        ) {
          await options.onProgress?.({
            activity: `${opportunities.length} verified so far. Expanding search wave ${wave + 2} across undercovered role and source cells.`,
          });
          const retryExclusions = [
            ...(options.excludeApplyUrls ?? []),
            ...seenUrls,
            ...opportunities.flatMap((opportunity) => [
              opportunity.sourceUrl,
              opportunity.applyUrl,
            ]),
          ];
          try {
            candidates = await discoverWebJobsWithAgent(
              codex,
              cwd,
              workspace,
              retryExclusions,
              Math.min(
                50,
                Math.max(5, (validatedTarget - opportunities.length) * 2),
              ),
              phase2Evidence,
              inspectionErrors,
              wave + 1,
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            inspectionErrors.push(`Search wave ${wave + 2}: ${reason}`);
            waveRecords[wave].nextDecision =
              "continue_with_partial_results_after_search_error";
            await options.onProgress?.({
              activity: `The next search wave could not complete. Continuing with ${opportunities.length} independently verified vacancies.`,
            });
            break;
          }
          await Promise.all(
            candidates
              .filter(
                (candidate) => classifySearchLead(candidate).kind === "vacancy",
              )
              .map((candidate) =>
              options.onProgress?.({
                item: progressItem(candidate),
                phase: "validation",
                state: "waiting",
              }),
              ),
          );
        }
      }
    } finally {
      await browsers.close(browser);
    }
    opportunities.sort((a, b) => b.fit - a.fit);
    await persistPhase2SearchAudit({
      dataRoot: dataRoot,
      workspace,
      searchRunId,
      evidenceRunId: phase2Evidence.evidenceRunId,
      startedAt: searchStartedAt,
      completedAt: new Date().toISOString(),
      limit,
      phase2Evidence,
      waves: waveRecords,
      opportunities,
      failures: deduplicateFailures(failures),
    });
    return {
      opportunities,
      applications: [],
      failures: deduplicateFailures(failures),
      seenUrls: [...seenUrls],
    };
}

export function validatedDiscoveryTarget(
  requestedVacancies: number,
  applicationTarget: number,
) {
  const requested = Math.max(1, Math.floor(requestedVacancies));
  const applications = Math.max(1, Math.floor(applicationTarget));
  return Math.min(
    requested,
    applications + 2,
  );
}

async function validateVacanciesWhileExpandingSource(input: {
  browser: Parameters<typeof resolveDiscoveredJobs>[0];
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  phase2Evidence: Phase2EvidenceContext;
  inventory: VacancySourceInventory;
  source: LiveCandidate;
  targetCandidates: number;
  shouldContinue: () => boolean;
  onProgress?: OpportunityProgressReporter;
}) {
  const executor = new BoundedExecutor(
    Math.min(3, vacancyValidationConcurrency()),
  );
  const validations: Array<Promise<LiveCandidate[]>> = [];

  await runVacancySource({
    browser: input.browser,
    codex: input.codex,
    cwd: input.cwd,
    workspace: input.workspace,
    phase2Evidence: input.phase2Evidence,
    inventory: input.inventory,
    source: input.source,
    targetCandidates: input.targetCandidates,
    shouldContinue: input.shouldContinue,
    onCandidate: (child) => {
      validations.push(
        executor.run(async () => {
          await input.onProgress?.({
            item: progressItem(child),
            phase: "validation",
            state: "running",
          });
          try {
            const resolved = await resolveDiscoveredJobs(
              input.browser,
              child,
              input.codex,
              input.cwd,
              input.workspace,
              1,
            );
            if (resolved.length === 0)
              await input.onProgress?.({
                item: progressItem(child),
                phase: "validation",
                state: "failed",
                reason: "No current vacancy was found at this source",
                validationDisposition: "unresolved",
              });
            return resolved;
          } catch (error) {
            await input.onProgress?.({
              item: progressItem(child),
              phase: "validation",
              state: "failed",
              reason: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        }),
      );
    },
  });

  return (await Promise.all(validations)).flat();
}

export async function persistPhase2SearchAudit(input: {
  dataRoot: string;
  workspace: JobSearchWorkspace;
  searchRunId: string;
  evidenceRunId: string;
  startedAt: string;
  completedAt: string;
  limit: number;
  phase2Evidence: Phase2EvidenceContext;
  waves: Array<Record<string, unknown>>;
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
}) {
  const sourceClasses = [
    "employer_career",
    "employer_ats",
    "specialist_board",
    "local_board",
    "general_aggregator",
    "search_engine",
    "employer_directory",
  ];
  const observedSources = new Set(
    input.opportunities.flatMap((job) =>
      (job.discoveryProvenance || []).map((item) => item.sourceClass),
    ),
  );
  observedSources.add("search_engine");
  const intent = discoveryWorkIntent(input.workspace);
  const geographies =
    intent.willingWorkLocations.length > 0
      ? intent.willingWorkLocations
      : intent.remoteEligibility.length > 0
        ? intent.remoteEligibility
        : ["unspecified"];
  const languages = input.workspace.profile.languages.length
    ? input.workspace.profile.languages
    : ["unspecified"];
  const lanes = input.phase2Evidence.searchLanes;
  const coverageCells = lanes.flatMap((lane) =>
    geographies.flatMap((geography) =>
      languages.flatMap((language) =>
        sourceClasses.map((sourceClass) => ({
          roleFamilyId: lane.roleFamilyId,
          geography,
          language,
          sourceClass,
          attempts: observedSources.has(sourceClass) ? input.waves.length : 0,
          uniqueLeads: input.opportunities.filter((job) =>
            job.discoveryProvenance?.some(
              (item) => item.sourceClass === sourceClass,
            ),
          ).length,
          validatedJobs: input.opportunities.filter((job) =>
            job.discoveryProvenance?.some(
              (item) => item.sourceClass === sourceClass,
            ),
          ).length,
          qualifiedJobs: 0,
          duplicateRate: 0,
          marginalYield: 0,
          status: observedSources.has(sourceClass) ? "active" : "unsearched",
        })),
      ),
    ),
  );
  const root = path.join(
    input.dataRoot,
    "job-search",
    "runs",
    input.workspace.candidateId,
    "search-runs",
    input.searchRunId,
  );
  await mkdir(root, { recursive: true });
  const jsonLines = (values: unknown[]) =>
    `${values.map((value) => JSON.stringify(value)).join("\n")}${values.length ? "\n" : ""}`;
  await Promise.all([
    writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify(
        {
          searchRunId: input.searchRunId,
          candidateId: input.workspace.candidateId,
          evidenceRunId: input.evidenceRunId,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          target: input.limit,
          validatedJobs: input.opportunities.length,
          failures: input.failures.length,
          stoppingDecision:
            input.waves.at(-1)?.nextDecision || "no_search_wave_completed",
          coverageLimitations: sourceClasses
            .filter((sourceClass) => !observedSources.has(sourceClass))
            .map((sourceClass) => `${sourceClass} was not reached in this run`),
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(
      path.join(root, "plan.json"),
      JSON.stringify(
        phase2DiscoveryPacket(input.phase2Evidence),
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(path.join(root, "waves.jsonl"), jsonLines(input.waves), "utf8"),
    writeFile(
      path.join(root, "coverage.jsonl"),
      jsonLines(coverageCells),
      "utf8",
    ),
    writeFile(
      path.join(root, "validated-jobs.jsonl"),
      jsonLines(input.opportunities),
      "utf8",
    ),
    writeFile(
      path.join(root, "rejected-leads.jsonl"),
      jsonLines(input.failures),
      "utf8",
    ),
  ]);
}

export function searchActivity(
  workspace: JobSearchWorkspace,
  limit: number,
  phase2Evidence: Phase2EvidenceContext,
) {
  const intent = discoveryWorkIntent(workspace);
  const location = intent.remoteEligibility.length
    ? intent.willingWorkLocations.length
      ? `remote roles in any region, plus hybrid/on-site roles in ${intent.willingWorkLocations.join(", ")}`
      : "remote roles in any region without country or timezone filtering"
    : intent.willingWorkLocations.join(", ") || "the candidate's allowed work locations";
  const evidence =
    phase2Evidence?.searchLanes
      .slice(0, 3)
      .map((lane) => lane.canonicalTitle)
      .join(", ") ||
    workspace.profile.skills.slice(0, 3).join(", ") ||
    workspace.profile.headline ||
    "the supplied CV evidence";
  return `Searching the public web for ${limit} new roles around ${evidence} in ${location}.`;
}


export async function discoverWebJobsWithAgent(
  codex: CodexExecClient,
  cwd: string,
  workspace: JobSearchWorkspace,
  alreadyFoundUrls: string[],
  requested: number,
  phase2Evidence: Phase2EvidenceContext,
  rejectionFeedback: string[] = [],
  waveNumber = 0,
): Promise<LiveCandidate[]> {
  const runtime = await codex.start();
  if (!runtime.authenticated)
    throw new Error("Codex is not authenticated for live web job search");
  const model = productionModel(WEB_SEARCH_COMMAND, runtime.model);
  const workIntent = discoveryWorkIntent(workspace);
  const canonicalPlan = phase2DiscoveryPacket(phase2Evidence);
  const queryPortfolio = phase2QueryPortfolio(phase2Evidence, waveNumber);
  const thread = await codex.startThread({
    cwd,
    callId: "search.web-discovery",
    role: WEB_SEARCH_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: WEB_SEARCH_COMMAND.approvalPolicy,
    webSearch: { mode: "live" },
    developerInstructions: WEB_SEARCH_ROLE_PROMPT,
  });
  const result = await codex.runTurn({
    threadId: thread.id,
    prompt: buildWebSearchInput({
      requested,
      candidateProfile: {
        ...workIntent,
        employmentTypes: workspace.profile.employmentTypes,
        salaryExpectation: workspace.profile.salaryExpectation,
      },
      canonicalPlan: {
        ...canonicalPlan,
        searchLanes: phase2ActiveSearchLanes(phase2Evidence, waveNumber),
        queryPortfolioForThisWave: queryPortfolio,
      },
      alreadyFoundUrls,
      rejectionFeedback,
    }),
    cwd,
    sandbox: WEB_SEARCH_COMMAND.sandbox,
    outputSchema: webSearchOutputSchema,
    model,
    approvalPolicy: WEB_SEARCH_COMMAND.approvalPolicy,
    effort: WEB_SEARCH_COMMAND.effort,
    timeoutMs: WEB_SEARCH_COMMAND.timeoutMs,
  });
  const parsed = JSON.parse(result.finalText) as WebSearchOutput;
  const seen = new Set(alreadyFoundUrls.map(normalizeOpportunityUrl));
  const candidates: LiveCandidate[] = [];
  for (const item of parsed.jobs) {
    if (canonicalOpportunityIsExcluded(phase2Evidence, item.title))
      continue;
    if (!isPublicWebUrl(item.jobUrl) || !isPublicWebUrl(item.applyUrl)) continue;
    const normalized = normalizeOpportunityUrl(item.applyUrl);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const job: DiscoveredJob = {
      id: createHash("sha256").update(normalized).digest("hex").slice(0, 20),
      title: repairMojibake(item.title.trim()),
      location: repairMojibake(item.location.trim()),
      workplaceType: repairMojibake(item.workplaceType.trim()),
      employmentType: repairMojibake(item.employmentType.trim()),
      isListed: true,
      isRemote: /remote|anywhere|worldwide|global/i.test(
        `${item.location} ${item.workplaceType}`,
      ),
      jobUrl: item.jobUrl.trim(),
      applyUrl: item.applyUrl.trim(),
      descriptionPlain: normalizeExtractedText(item.description.trim()),
      compensation: normalizeCompensationText(item.compensation.trim()),
      sourceKind: item.sourceKind,
      discoveryQuery: item.discoveryQuery.trim(),
      discoveryWave: waveNumber + 1,
      sourceClass: item.sourceClass,
    };
    candidates.push({
      company: repairMojibake(item.company.trim()),
      job,
      preliminaryFit: canonicalOpportunityAlignment(phase2Evidence, {
        title: job.title,
        description: job.descriptionPlain,
      }),
    });
  }
  return candidates;
}

export function mergeSearchCandidates(...groups: LiveCandidate[][]) {
  const merged = new Map<string, LiveCandidate>();
  for (const candidate of groups.flat()) {
    const key = normalizeOpportunityUrl(candidate.job.jobUrl);
    const existing = merged.get(key);
    if (
      !existing ||
      classifySearchLead(candidate).kind === "vacancy_search"
    )
      merged.set(key, candidate);
  }
  return [...merged.values()];
}
