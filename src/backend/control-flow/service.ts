import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCandidateEvidence,
  acquireEvidence,
  type EvidenceInput,
} from "../../01-evidence-ingestion/evidence-ingestion.js";
import {
  cleanupReplacedCvArtifacts,
  safeExtension,
} from "../../01-evidence-ingestion/01-evidence-acquisition/cv/upload-cv.js";
import type { CandidateAnalyzer } from "../../01-evidence-ingestion/types.js";
import { EvidenceNeedsReviewError } from "../../01-evidence-ingestion/02-chunk-reader/recovery/index.js";
import {
  readSupplementalEvidence,
} from "../../01-evidence-ingestion/01-evidence-acquisition/additional-evidence/read-source.js";
import {
  evidenceUrlsMatch,
} from "../../01-evidence-ingestion/01-evidence-acquisition/additional-evidence/add-evidence.js";
export { evidenceUrlsMatch };
import {
  isProfileEvidenceField,
  PROFILE_EVIDENCE_FIELDS,
  profileSourceError,
  stageProfileEvidenceSources,
  synchronizeProfileEvidenceSources,
  type ProfileEvidenceField,
} from "../../01-evidence-ingestion/01-evidence-acquisition/additional-evidence/profile-links.js";
export { stageProfileEvidenceSources };
import type {
  ApplicationDraft,
  BackgroundExecutionControl,
  CandidateProfile,
  CandidateSource,
  BackgroundSearchOperation,
  FormField,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
  SearchPipelineItem,
} from "../../contracts/job-search.js";
import { normalizeCompensationText } from "../../search-match-shared/opportunity.js";
import type {
  OpportunityResearchProvider,
  OpportunityProgressUpdate,
} from "../../search-match-shared/types.js";
import { VacancySourceInventory } from "../../02-search/02-vacancy-source-expansion/inventory/index.js";
import type { CoverLetterWriter } from "../../04-application-preparation/types.js";
import { renderTailoredCvDocx } from "../../04-application-preparation/06-cv-tailoring/document.js";
import {
  compatibleCandidateValue,
  REUSABLE_CANDIDATE_KEYS,
  reusableCandidateKey,
  syncProfileFact,
} from "../../search-match-shared/candidate-facts.js";
import { normalizeExtractedText, repairMojibake } from "../../infrastructure/text-encoding.js";
import {
  needsWillingWorkLocation,
  parseWorkLocationAnswer,
} from "../../search-match-shared/work-preferences.js";
import {
  readCurrentEvidenceModel,
} from "../../01-evidence-ingestion/04-verification/evidence-model.js";
import { normalizeSearchValidationFailure } from "../../02-search/03-vacancy-validation/failure-classification.js";
import {
  FileWorkspaceStore,
  type WorkspaceStore,
} from "../persistence/workspace-store.js";

const CANDIDATE_ID = "candidate-1";

interface JobNumberRegistry {
  version: 2;
  nextJobNumber: number;
  byKey: Record<string, number>;
}

interface NumberableJob {
  id: string;
  title?: string;
  jobNumber?: number;
  sourceUrl?: string;
  applyUrl?: string;
}

export class JobSearchService {
  private readonly directory: string;
  private readonly jobNumbersFile: string;
  private readonly filesDirectory: string;
  private readonly runsDirectory: string;
  private readonly sourceSnapshotsDirectory: string;
  private readonly analysisCheckpointsDirectory: string;
  private readonly activeAnalyses = new Map<string, Promise<void>>();
  private readonly requestedAnalyses = new Set<string>();
  private readonly activeFindMore = new Map<string, Promise<void>>();
  private readonly activeProfileSourceSync = new Map<string, Promise<void>>();
  private readonly profileSourceAbort = new Map<string, AbortController>();
  private readonly activeSearchMode = new Map<string, BackgroundSearchOperation>();
  private readonly stoppedSnapshots = new Map<string, JobSearchWorkspace>();
  private readonly stoppedCandidates = new Set<string>();
  private readonly requestedProfileSourceSync = new Set<string>();
  private readonly candidateWrites = new Map<string, Promise<void>>();
  private readonly candidateCache = new Map<string, JobSearchWorkspace>();
  private jobNumberRegistry?: JobNumberRegistry;
  private jobNumberAllocation: Promise<void> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly analyzer?: CandidateAnalyzer,
    private readonly opportunityResearch?: OpportunityResearchProvider,
    private readonly coverLetterWriter?: CoverLetterWriter,
    private readonly profileSourceIngestor: typeof readSupplementalEvidence = readSupplementalEvidence,
    private readonly workspaceStore: WorkspaceStore = new FileWorkspaceStore(
      path.join(root, "job-search", "candidates"),
    ),
  ) {
    this.directory = path.join(root, "job-search", "candidates");
    this.jobNumbersFile = path.join(root, "job-search", "job-numbers.json");
    this.filesDirectory = path.join(root, "job-search", "files");
    this.runsDirectory = path.join(root, "job-search", "runs");
    this.sourceSnapshotsDirectory = path.join(
      root,
      "job-search",
      "source-snapshots",
    );
    this.analysisCheckpointsDirectory = path.join(
      root,
      "job-search",
      "analysis-checkpoints",
    );
  }

  async initialize(
    options: { defaultCandidateId?: string | false } = {},
  ): Promise<void> {
    await Promise.all([
      mkdir(this.directory, { recursive: true }),
      mkdir(this.filesDirectory, { recursive: true }),
      mkdir(this.runsDirectory, { recursive: true }),
      mkdir(this.sourceSnapshotsDirectory, { recursive: true }),
      mkdir(this.analysisCheckpointsDirectory, { recursive: true }),
      this.workspaceStore.initialize(),
    ]);
    await this.ensureJobNumberRegistry();
    const defaultCandidateId =
      options.defaultCandidateId === false
        ? undefined
        : options.defaultCandidateId ?? CANDIDATE_ID;
    if (!defaultCandidateId) return;
    const stored = await this.workspaceStore.load(defaultCandidateId);
    if (stored) {
      const workspace = normalizeWorkspace(stored, defaultCandidateId);
      this.candidateCache.set(defaultCandidateId, structuredClone(workspace));
      if (workspace.backgroundExecution?.state === "stopped")
        this.stoppedCandidates.add(defaultCandidateId);
      await this.assignJobNumbers([
        ...workspace.opportunities,
        ...workspace.rejectedOpportunities,
        ...workspace.searchValidationIssues,
        ...(workspace.searchProgress?.items ?? []),
      ]);
      if (
        workspace.searchProgress?.stage === "looking" ||
        workspace.searchProgress?.stage === "verifying" ||
        workspace.searchProgress?.stage === "filling"
      ) {
        workspace.searchProgress = {
          ...workspace.searchProgress,
          stage: "failed",
          target: workspace.searchProgress.target,
          found: workspace.searchProgress.found,
          error:
            "The previous search was interrupted by a server restart. Existing verified jobs and applications were preserved; search again to continue.",
        };
      }
      const profileSources = stageProfileEvidenceSources(
        workspace,
        PROFILE_EVIDENCE_FIELDS,
      );
      await this.saveCandidate(workspace);
      if (
        profileSources.needsFetch &&
        !this.isExecutionStopped(defaultCandidateId)
      )
        this.queueProfileSourceSync(defaultCandidateId);
      if (
        !this.isExecutionStopped(defaultCandidateId) &&
        !workspace.sources.some(
          (source) => source.profileField && source.status === "processing",
        ) &&
        (workspace.intelligence.status === "analyzing" ||
          workspace.sources.some((source) => source.status === "processing") ||
          workspace.sources.some(
            (source) => source.status === "ready" && !source.knowledgePath,
          ))
      )
        this.queueCandidateAnalysis(defaultCandidateId);
      return;
    }
    const workspace = emptyWorkspace(defaultCandidateId, {
      name: "",
      email: "",
      location: "",
    });
    await this.assignJobNumbers([
      ...workspace.opportunities,
      ...workspace.rejectedOpportunities,
      ...workspace.searchValidationIssues,
      ...(workspace.searchProgress?.items ?? []),
    ]);
    await this.saveCandidate(workspace);
  }

  async get(candidateId = CANDIDATE_ID): Promise<JobSearchWorkspace> {
    return this.getCandidate(candidateId);
  }

  async canonicalEvidence(candidateId?: string) {
    const id = candidateId || CANDIDATE_ID;
    return readCurrentEvidenceModel(this.root, id);
  }


  async updateProfile(
    input: Partial<
      Pick<
        CandidateProfile,
        | "name"
        | "email"
        | "phone"
        | "linkedin"
        | "github"
        | "website"
        | "location"
        | "workAuthorization"
      >
    >,
    options: { deferEvidenceAnalysis?: boolean } = {},
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const changedEvidenceFields = new Set<ProfileEvidenceField>();
    let profileChanged = false;
    for (const field of [
      "name",
      "email",
      "phone",
      "linkedin",
      "github",
      "website",
      "location",
      "workAuthorization",
    ] as const) {
      if (typeof input[field] === "string") {
        const next = input[field].trim();
        if (next !== workspace.profile[field]) profileChanged = true;
        if (
          isProfileEvidenceField(field) &&
          next !== workspace.profile[field]
        )
          changedEvidenceFields.add(field);
        workspace.profile[field] = next;
      }
    }
    if (profileChanged) workspace.discoveryNeedsRun = true;
    if (changedEvidenceFields.size > 0) workspace.profileSetupStep = 2;
    const profileSources = stageProfileEvidenceSources(
      workspace,
      changedEvidenceFields,
    );
    if (
      changedEvidenceFields.size > 0 &&
      profileSources.changed &&
      !profileSources.needsFetch
    )
      invalidateEvidenceAnalysis(workspace);
    syncSharedAnswersFromProfile(workspace);
    recalculate(workspace);
    advanceProfileSetupAfterAnalysis(workspace);
    await this.saveCandidate(workspace);
    if (profileSources.needsFetch && !options.deferEvidenceAnalysis)
      this.queueProfileSourceSync(workspace.candidateId);
    else if (profileSources.changed && !options.deferEvidenceAnalysis)
      this.queueCandidateAnalysis(workspace.candidateId);
    return workspace;
  }


  async addSource(
    input: EvidenceInput,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const replacedCvs =
      input.kind === "cv"
        ? workspace.sources.filter((source) => source.kind === "cv")
        : [];
    await acquireEvidence({
      dataRoot: this.root,
      workspace,
      source: input,
      analyzeWithLlm: Boolean(this.analyzer),
    });
    if (input.kind === "cv")
      for (const application of workspace.applications)
        delete application.tailoredCv;
    recalculate(workspace);
    const installedCv =
      input.kind === "cv"
        ? workspace.sources.find((source) => source.kind === "cv")
        : undefined;
    try {
      await this.saveCandidate(workspace);
    } catch (error) {
      if (installedCv?.originalFile)
        await rm(
          path.join(
            this.root,
            "job-search",
            "files",
            workspace.candidateId,
            `${installedCv.id}${safeExtension(installedCv.originalFile.name)}`,
          ),
          { force: true },
        ).catch(() => undefined);
      throw error;
    }
    if (input.kind === "cv")
      await cleanupReplacedCvArtifacts(
        this.root,
        workspace.candidateId,
        replacedCvs,
      ).catch(() => undefined);
    return this.analyzer ? workspace : this.applyLocalAnalysis(workspace);
  }

  async analyzeCandidate(
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    await this.activeProfileSourceSync.get(candidateId);
    let workspace = await this.getCandidate(candidateId);
    if (
      workspace.sources.some(
        (source) =>
          source.profileField &&
          source.status === "processing" &&
          Boolean(source.url),
      )
    ) {
      await this.synchronizeProfileSources(candidateId, false);
      workspace = await this.getCandidate(candidateId);
    }
    if (this.analyzer) {
      invalidateEvidenceAnalysis(workspace);
      await this.saveCandidate(workspace);
    }
    this.queueCandidateAnalysis(workspace.candidateId);
    await this.activeAnalyses.get(workspace.candidateId);
    const analyzed = await this.getCandidate(workspace.candidateId);
    const previousStep = analyzed.profileSetupStep;
    advanceProfileSetupAfterAnalysis(analyzed);
    if (analyzed.profileSetupStep !== previousStep) {
      await this.saveCandidate(analyzed);
    }
    return analyzed;
  }

  async removeSource(
    sourceId: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const index = workspace.sources.findIndex((source) => source.id === sourceId);
    if (index < 0) throw new Error("Unknown candidate evidence source");
    const [removed] = workspace.sources.splice(index, 1);
    workspace.discoveryNeedsRun = true;
    if (removed.profileField) workspace.profile[removed.profileField] = "";
    if (removed.kind === "cv")
      workspace.finalCv =
        [...workspace.sources].reverse().find((source) => source.kind === "cv")
          ?.content || "";
    workspace.profileSetupStep = workspace.sources.some(
      (source) => source.kind === "cv",
    )
      ? 2
      : 1;
    syncSharedAnswersFromProfile(workspace);
    if (this.analyzer && workspace.sources.length)
      invalidateEvidenceAnalysis(workspace);
    else workspace.intelligence = emptyIntelligence();
    recalculate(workspace);
    await this.saveCandidate(workspace);
    if (this.analyzer && workspace.sources.length)
      this.queueCandidateAnalysis(workspace.candidateId);
    else if (!this.analyzer) await this.applyLocalAnalysis(workspace);
    return workspace;
  }

  async markSourceReadingStopped(
    sourceId: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const source = workspace.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("Unknown candidate evidence source");
    source.status = "needs_review";
    source.analysisRequired = false;
    source.error =
      "Reading was stopped. This source is saved but is not included in candidate evidence.";
    if (!workspace.sources.some((item) => item.status === "processing")) {
      workspace.intelligence.status = "ready";
      workspace.intelligence.error = undefined;
      workspace.intelligence.progress = undefined;
    }
    advanceProfileSetupAfterAnalysis(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }

  queueCandidateAnalysis(candidateId: string): void {
    if (!this.analyzer) return;
    this.requestedAnalyses.add(candidateId);
    if (this.isExecutionStopped(candidateId)) return;
    if (this.activeAnalyses.has(candidateId)) return;
    const run = this.drainCandidateAnalysis(candidateId).finally(() =>
      this.activeAnalyses.delete(candidateId),
    );
    this.activeAnalyses.set(candidateId, run);
  }

  private queueProfileSourceSync(candidateId: string): void {
    this.requestedProfileSourceSync.add(candidateId);
    if (this.isExecutionStopped(candidateId)) return;
    if (this.activeProfileSourceSync.has(candidateId)) return;
    const run = this.drainProfileSourceSync(candidateId).finally(() =>
      this.activeProfileSourceSync.delete(candidateId),
    );
    this.activeProfileSourceSync.set(candidateId, run);
  }

  private async drainProfileSourceSync(candidateId: string): Promise<void> {
    while (
      !this.isExecutionStopped(candidateId) &&
      this.requestedProfileSourceSync.delete(candidateId)
    )
      await this.synchronizeProfileSources(candidateId);
  }

  private async synchronizeProfileSources(
    candidateId: string,
    queueAnalysis = true,
  ): Promise<void> {
    this.assertBackgroundExecutionRunning(candidateId);
    const abortController = new AbortController();
    this.profileSourceAbort.set(candidateId, abortController);
    const result = await synchronizeProfileEvidenceSources({
      workspace: await this.getCandidate(candidateId),
      reloadWorkspace: () => this.getCandidate(candidateId),
      analyzeWithLlm: Boolean(this.analyzer),
      signal: abortController.signal,
      reader: this.profileSourceIngestor,
    });
    if (this.profileSourceAbort.get(candidateId) === abortController)
      this.profileSourceAbort.delete(candidateId);
    if (this.isExecutionStopped(candidateId)) return;
    const { workspace: current, successes, pendingAnalysis } = result;
    recalculate(current);
    await this.saveCandidate(current);
    if (queueAnalysis && (pendingAnalysis || successes > 0)) {
      if (this.analyzer && pendingAnalysis) this.queueCandidateAnalysis(candidateId);
      else await this.applyLocalAnalysis(current);
    }
  }

  async sourceFile(
    candidateId: string,
    sourceId: string,
  ): Promise<{ file: string; name: string; mimeType: string; size: number }> {
    const workspace = await this.getCandidate(candidateId);
    const source = workspace.sources.find((item) => item.id === sourceId);
    if (!source?.originalFile)
      throw new Error(
        "Original file is unavailable; upload the document again to enable the original preview",
      );
    const file = path.join(
      this.filesDirectory,
      candidateId,
      `${source.id}${safeExtension(source.originalFile.name)}`,
    );
    const info = await stat(file);
    return {
      file,
      name: source.originalFile.name,
      mimeType: mimeTypeFromFilename(source.originalFile.name),
      size: info.size,
    };
  }

  async answer(
    questionId: string,
    answer: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const question = workspace.questions.find((item) => item.id === questionId);
    if (!question) throw new Error("Unknown intake question");
    const nextAnswer = answer.trim();
    if (nextAnswer !== question.answer) workspace.discoveryNeedsRun = true;
    question.answer = nextAnswer;
    applyAnswer(workspace, questionId, question.answer);
    recalculate(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }

  async finishIntake(candidateId = CANDIDATE_ID): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    if (
      workspace.questions.some((q) => q.required && !q.answer.trim()) ||
      !workspace.sources.some((s) => s.kind === "cv") ||
      !workspace.profile.name.trim() ||
      !isValidEmail(workspace.profile.email) ||
      workspace.intelligence.status !== "ready" ||
      workspace.intelligence.evidenceRun?.readyForSearch === false
    )
      throw new Error(
        "Add a CV, confirm name and email, complete required job information, and resolve canonical evidence blockers before search",
      );
    workspace.phase = "search";
    workspace.profileSetupStep = 4;
    await this.saveCandidate(workspace);
    return workspace;
  }

  async markWorkflowQueued(
    type:
      | "analyze"
      | "prepare"
      | "prepare-search-ready"
      | "find-more"
      | "tailor-cv",
    candidateId = CANDIDATE_ID,
    resourceId?: string,
  ) {
    const workspace = await this.get(candidateId);
    if (type === "tailor-cv") {
      const application = requireApplication(workspace, resourceId || "");
      if (!workspace.finalCv.trim())
        throw new Error("Upload a readable CV before generating a tailored version");
      if (application.outcome === "applied_waiting")
        throw new Error("Restore the applied application before tailoring its CV");
      application.tailoredCv = {
        status: "processing",
        content: application.tailoredCv?.content ?? "",
        changeSummary: application.tailoredCv?.changeSummary ?? [],
        fileName:
          application.tailoredCv?.fileName ||
          tailoredCvFileName(workspace, application),
      };
      application.updatedAt = new Date().toISOString();
    } else if (type === "analyze") {
      workspace.intelligence.status = "analyzing";
      workspace.intelligence.error = undefined;
      for (const source of workspace.sources)
        if (
          source.analysisRequired ||
          (source.status === "ready" && !source.knowledgePath)
        )
          source.status = "processing";
    } else {
      const target =
        type === "prepare-search-ready"
          ? workspace.searchReadyOpportunities.length
          : workspace.searchConfig.applicationTarget;
      workspace.discoveryNeedsRun = false;
      workspace.phase = "applications";
      workspace.searchProgress = {
        stage: type === "prepare-search-ready" ? "verifying" : "looking",
        target,
        found: 0,
        activity:
          type === "find-more"
            ? "Queued to find and prepare more applications."
            : type === "prepare-search-ready"
              ? "Queued to match verified vacancies and prepare applications."
              : "Queued to search and prepare verified applications.",
        updatedAt: new Date().toISOString(),
        items: workspace.searchProgress?.items ?? [],
        events: [
          ...(workspace.searchProgress?.events ?? []),
          progressEvent("Workflow queued."),
        ].slice(-10),
      };
    }
    await this.saveCandidate(workspace);
    return workspace;
  }

  async markWorkflowFailed(
    type:
      | "analyze"
      | "prepare"
      | "prepare-search-ready"
      | "find-more"
      | "revalidate-search"
      | "tailor-cv",
    error: string,
    candidateId = CANDIDATE_ID,
    resourceId?: string,
  ) {
    const workspace = await this.get(candidateId);
    if (type === "tailor-cv") {
      const application = requireApplication(workspace, resourceId || "");
      application.tailoredCv = {
        status: "failed",
        content: application.tailoredCv?.content ?? "",
        changeSummary: application.tailoredCv?.changeSummary ?? [],
        fileName:
          application.tailoredCv?.fileName ||
          tailoredCvFileName(workspace, application),
        error,
      };
      application.updatedAt = new Date().toISOString();
    } else if (type === "analyze") {
      workspace.intelligence.status = "failed";
      workspace.intelligence.error = error;
      workspace.intelligence.progress = undefined;
      for (const source of workspace.sources)
        if (source.status === "processing") {
          source.status = "analysis_failed";
          source.error = error;
        }
    } else {
      workspace.searchProgress = {
        ...(workspace.searchProgress ?? {
          target: workspace.searchConfig.applicationTarget,
          found: 0,
          items: [],
        }),
        stage: "failed",
        error,
        activity: `The queued workflow failed: ${error}`,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.saveCandidate(workspace);
    return workspace;
  }

  async stopBackgroundWork(
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    // Set the in-memory gate before the first await so concurrent callbacks
    // cannot schedule another batch while the stop request is being saved.
    this.stoppedCandidates.add(candidateId);
    this.requestedAnalyses.delete(candidateId);
    this.requestedProfileSourceSync.delete(candidateId);
    const cachedAtStop = this.candidateCache.get(candidateId);
    this.profileSourceAbort.get(candidateId)?.abort();
    this.profileSourceAbort.delete(candidateId);
    const cancelResearch =
      this.opportunityResearch?.cancel?.(candidateId) ??
      this.opportunityResearch?.cancelAll?.() ??
      Promise.resolve();
    const activeWork = [
      cancelResearch,
      this.activeFindMore.get(candidateId),
      this.activeAnalyses.get(candidateId),
      this.activeProfileSourceSync.get(candidateId),
    ].filter((work): work is Promise<void> => Boolean(work));
    const workspace = cachedAtStop
      ? structuredClone(cachedAtStop)
      : await this.get(candidateId);
    const searchRunning = isSearchProgressRunning(workspace.searchProgress);
    const resumeCandidateAnalysis =
      this.activeAnalyses.has(workspace.candidateId) ||
      workspace.intelligence.status === "analyzing";
    const resumeProfileSourceSync = this.activeProfileSourceSync.has(
      workspace.candidateId,
    );
    const resumeSearch = searchRunning
      ? this.activeSearchMode.get(workspace.candidateId) ?? "prepare"
      : undefined;

    workspace.backgroundExecution = {
      state: "stopped",
      stoppedAt: new Date().toISOString(),
      resumeCandidateAnalysis,
      resumeProfileSourceSync,
      resumeSearch,
    };
    if (resumeCandidateAnalysis) {
      workspace.intelligence.status = "idle";
      workspace.intelligence.error = undefined;
      workspace.intelligence.progress = undefined;
      for (const source of workspace.sources)
        if (
          source.status === "processing" &&
          !(resumeProfileSourceSync && source.profileField)
        ) {
          source.status = "ready";
          source.analysisRequired = true;
        }
    }
    if (searchRunning && workspace.searchProgress) {
      workspace.searchProgress = {
        ...workspace.searchProgress,
        stage: "stopped",
        error: undefined,
        activity:
          "Stopped by user. Completed jobs and applications are preserved.",
        updatedAt: new Date().toISOString(),
        events: [
          ...(workspace.searchProgress.events ?? []),
          progressEvent("Background work stopped by user."),
        ].slice(-10),
      };
    }
    this.stoppedSnapshots.set(workspace.candidateId, structuredClone(workspace));
    await this.saveCandidate(workspace);
    await Promise.allSettled(activeWork);
    this.stoppedSnapshots.delete(workspace.candidateId);
    return this.getCandidate(workspace.candidateId);
  }

  async continueBackgroundWork(
    candidateId = CANDIDATE_ID,
    scheduleWork = true,
    resumeOverride?: BackgroundExecutionControl,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const persistedControl = workspace.backgroundExecution;
    const persistedStop = persistedControl?.state === "stopped";
    const control =
      persistedStop
        ? persistedControl
        : resumeOverride?.state === "stopped"
          ? resumeOverride
          : undefined;
    if (!control) return workspace;
    const hasResumableWork = Boolean(
      control.resumeCandidateAnalysis ||
        control.resumeProfileSourceSync ||
        control.resumeSearch,
    );
    if (!persistedStop && !hasResumableWork) return workspace;
    this.stoppedCandidates.delete(workspace.candidateId);
    this.stoppedSnapshots.delete(workspace.candidateId);
    workspace.backgroundExecution = { state: "running" };

    if (control.resumeCandidateAnalysis) {
      workspace.intelligence.status = "analyzing";
      workspace.intelligence.error = undefined;
      for (const source of workspace.sources)
        if (source.analysisRequired) source.status = "processing";
    }
    if (control.resumeSearch && workspace.searchProgress) {
      workspace.searchProgress = {
        ...workspace.searchProgress,
        stage: "looking",
        error: undefined,
        activity: "Continuing the stopped workflow from saved progress.",
        updatedAt: new Date().toISOString(),
        events: [
          ...(workspace.searchProgress.events ?? []),
          progressEvent("Continuing background work from saved progress."),
        ].slice(-10),
      };
    }
    await this.saveCandidate(workspace);

    if (!scheduleWork) return workspace;

    if (control.resumeProfileSourceSync)
      this.queueProfileSourceSync(workspace.candidateId);
    else if (control.resumeCandidateAnalysis)
      this.queueCandidateAnalysis(workspace.candidateId);

    if (control.resumeSearch) {
      if (control.resumeSearch === "prepare")
        this.trackSearchTask(
          workspace,
          "prepare",
          this.prepareApplications(
            workspace.candidateId,
            workspace.searchProgress?.target,
          ),
          "Search stopped before the pipeline completed.",
        );
      else if (control.resumeSearch === "prepare_search_ready")
        return this.startPrepareSearchReadyApplications(candidateId);
    }
    return this.getCandidate(workspace.candidateId);
  }

  async startPrepareApplications(
    applicationTargetOverride?: number,
    append = false,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(candidateId);
    const workspace = await this.get(candidateId);
    if (this.activeFindMore.has(workspace.candidateId)) return workspace;
    const applicationTarget =
      applicationTargetOverride ?? workspace.searchConfig.applicationTarget;
    workspace.discoveryNeedsRun = false;
    workspace.phase = "applications";
    workspace.searchProgress = {
      stage: "looking",
      target: applicationTarget,
      found: 0,
      activity: append
        ? `Preparing ${applicationTarget} new applications. Existing application jobs are excluded; other jobs may be reconsidered.`
        : `Searching until ${applicationTarget} applications are prepared and independently verified. Missing candidate information may be completed later.`,
      updatedAt: new Date().toISOString(),
      items: [],
      events: [
        progressEvent(
          append
            ? `Preparing ${applicationTarget} new applications.`
            : `Searching until ${applicationTarget} applications are prepared and independently verified.`,
        ),
      ],
      baselineApplicationJobIds: [...preparedVerifiedJobIds(workspace)],
    };
    await this.saveCandidate(workspace);
    this.trackSearchTask(
      workspace,
      "prepare",
      this.prepareApplications(workspace.candidateId, applicationTarget),
      "Search stopped before the pipeline completed.",
    );
    return workspace;
  }

  async prepareApplications(
    candidateId?: string,
    applicationTargetOverride?: number,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(candidateId);
    const workspace = candidateId
      ? await this.getCandidate(candidateId)
      : await this.get();
    workspace.discoveryNeedsRun = false;
    if (!this.opportunityResearch)
      throw new Error("Live opportunity research is not configured");
    if (!this.coverLetterWriter)
      throw new Error("Cover letter generation is not configured");
    let pendingProgressWrite = Promise.resolve();
    const reportProgress = async (update: OpportunityProgressUpdate) => {
      this.assertBackgroundExecutionRunning(workspace.candidateId);
      if (update.item) await this.assignJobNumbers([update.item]);
      applyProgressUpdate(workspace, update);
      pendingProgressWrite = pendingProgressWrite.then(() =>
        this.saveCandidate(workspace),
      );
      await pendingProgressWrite;
    };
    const applicationTarget =
      applicationTargetOverride ?? workspace.searchConfig.applicationTarget;
    const preparedBeforeRun = new Set(
      workspace.searchProgress?.baselineApplicationJobIds ??
        preparedVerifiedJobIds(workspace),
    );
    const hadApplicationAttemptsBeforeRun = workspace.applications.length > 0;
    const preparedThisRun = () =>
      [...preparedVerifiedJobIds(workspace)].filter(
        (jobId) => !preparedBeforeRun.has(jobId),
      ).length;
    const maxRefillRounds = applicationRefillRoundLimit();
    let noCandidateRounds = 0;
    let roundsCompleted = 0;

    while (
      preparedThisRun() < applicationTarget &&
      roundsCompleted < maxRefillRounds &&
      noCandidateRounds < 2
    ) {
      const completed = preparedThisRun();
      const remaining = applicationTarget - completed;
      setSearchStage(
        workspace,
        "looking",
        applicationTarget,
        completed,
        roundsCompleted === 0
          ? `Reviewing scored replacements and searching only if needed to prepare ${applicationTarget} complete applications.`
          : `${completed} of ${applicationTarget} applications are complete; trying scored replacements for the remaining ${remaining} before searching again.`,
      );
      await this.saveCandidate(workspace);

      const applicationJobIds = new Set(
        workspace.applications.map((application) => application.jobId),
      );
      const existingApplicationJobs = workspace.opportunities.filter((job) =>
        applicationJobIds.has(job.id),
      );
      const bench = workspace.opportunities.filter(
        (job) => !applicationJobIds.has(job.id),
      );
      const revalidated = bench.length === 0
        ? { opportunities: [] as JobOpportunity[], failures: [] as JobResearchFailure[] }
        : this.opportunityResearch.revalidate
        ? await this.opportunityResearch.revalidate(workspace, bench, reportProgress)
        : { opportunities: bench, failures: [] };
      await this.assignJobNumbers([
        ...revalidated.opportunities,
        ...revalidated.failures,
      ]);
      mergeResearchFailures(workspace, revalidated.failures);

      const applicationUrls = uniqueUrls(
        existingApplicationJobs.flatMap((job) => [job.sourceUrl, job.applyUrl]),
      );
      const excludedUrls = new Set(applicationUrls.map(normalizeUrl));
      const reusableBench = revalidated.opportunities.filter(
        (job) =>
          hasReusableAssessment(job) &&
          job.fit >= applicationMinimumFit(),
      );
      const discoveryLimit = discoveryLimitAfterBenchValidation({
        remainingApplications: remaining,
        reusableOpenJobs: reusableBench.length,
        configuredDiscoveryTarget: workspace.searchConfig.discoveryTarget,
        firstBatch: !hadApplicationAttemptsBeforeRun,
        refillRound: roundsCompleted,
      });
      const discovered =
        discoveryLimit === 0
          ? {
              opportunities: [] as JobOpportunity[],
              applications: [] as ApplicationDraft[],
              failures: [] as JobResearchFailure[],
              seenUrls: [] as string[],
            }
          : this.opportunityResearch.researchAndAssess
              ? await this.opportunityResearch.researchAndAssess(workspace, {
                  excludeApplyUrls: applicationUrls,
                  limit: discoveryLimit,
                  onProgress: reportProgress,
                  onMatchedOpportunity: async (job) => {
                    await this.assignJobNumbers([job]);
                    workspace.opportunities = mergeUniqueJobs(
                      workspace.opportunities,
                      [job],
                    ).sort((left, right) => right.fit - left.fit);
                    pendingProgressWrite = pendingProgressWrite.then(() =>
                      this.saveCandidate(workspace),
                    );
                    await pendingProgressWrite;
                  },
                })
              : await this.opportunityResearch.research(workspace, {
                  excludeApplyUrls: applicationUrls,
                  limit: discoveryLimit,
                  onProgress: reportProgress,
                });
      await pendingProgressWrite;
      const unseenDiscovered = discovered.opportunities.filter(
        (job) =>
          !excludedUrls.has(normalizeUrl(job.sourceUrl)) &&
          !excludedUrls.has(normalizeUrl(job.applyUrl)),
      );
      const unseenIds = new Set(unseenDiscovered.map((job) => job.id));
      const fallbackApplications = discovered.applications.filter((application) =>
        unseenIds.has(application.jobId),
      );
      await this.assignJobNumbers([
        ...revalidated.opportunities,
        ...unseenDiscovered,
        ...(discovered.failures ?? []),
      ]);
      const nextSeenJobUrls = uniqueUrls([
        ...workspace.seenJobUrls,
        ...(discovered.seenUrls ?? []),
        ...discovered.opportunities.flatMap((job) => [job.sourceUrl, job.applyUrl]),
        ...(discovered.failures ?? []).flatMap((job) => [job.sourceUrl, job.applyUrl]),
      ]);
      mergeResearchFailures(workspace, discovered.failures ?? []);
      const candidates = mergeUniqueJobs(
        revalidated.opportunities,
        unseenDiscovered,
      );
      roundsCompleted += 1;
      workspace.seenJobUrls = nextSeenJobUrls;

      if (candidates.length === 0) {
        noCandidateRounds += 1;
        workspace.jobHistory = normalizeJobHistory(workspace);
        await this.saveCandidate(workspace);
        continue;
      }
      noCandidateRounds = 0;
      await this.continueAfterVacancyVerification({
        workspace,
        candidates,
        existingApplicationJobs,
        fallbackApplications,
        nextSeenJobUrls,
        selectionLimit: remaining,
        reportProgress,
        waitForProgress: () => pendingProgressWrite,
      });
    }

    const prepared = preparedThisRun();
    const complete = prepared >= applicationTarget;
    setSearchStage(
      workspace,
      "ready",
      applicationTarget,
      prepared,
      complete
        ? `${prepared} of ${applicationTarget} applications are prepared and independently verified. Some may still need candidate information before submission.`
        : `${prepared} of ${applicationTarget} applications are prepared and independently verified. The quota could not be completed from the eligible, accessible vacancies returned in ${roundsCompleted} refill ${roundsCompleted === 1 ? "round" : "rounds"}.`,
    );
    if (!complete)
      workspace.searchProgress!.error =
        `Prepared ${prepared} of ${applicationTarget}; no more verified applications could be produced from the bounded search.`;
    await pendingProgressWrite;
    finalizePipelineHistory(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }

  async startPrepareSearchReadyApplications(
    candidateId = CANDIDATE_ID,
    applicationTargetOverride?: number,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(candidateId);
    const workspace = await this.get(candidateId);
    if (this.activeFindMore.has(workspace.candidateId)) return workspace;
    const applicationJobIds = new Set(
      workspace.applications.map((application) => application.jobId),
    );
    const ready = workspace.searchReadyOpportunities.filter(
      (job) => !applicationJobIds.has(job.id),
    );
    if (ready.length === 0)
      throw new Error("There are no search-verified vacancies ready for matching");
    workspace.phase = "applications";
    workspace.searchProgress = {
      stage: "verifying",
      target: Math.min(
        applicationTargetOverride ?? workspace.searchConfig.applicationTarget,
        ready.length,
      ),
      found: ready.length,
      activity: `Passing ${ready.length} search-verified vacancies into evidence matching.`,
      updatedAt: new Date().toISOString(),
      items: ready.map((job) => ({
        ...pipelineIdentity(job),
        validation: "passed",
        match: "waiting",
        application: "waiting",
        applicationVerification: "waiting",
      })),
      events: [
        progressEvent(
          `Passing ${ready.length} search-verified vacancies into evidence matching.`,
        ),
      ],
    };
    await this.saveCandidate(workspace);
    this.trackSearchTask(
      workspace,
      "prepare_search_ready",
      this.prepareSearchReadyApplications(
        workspace.candidateId,
        applicationTargetOverride,
      ),
      "Matching or application preparation stopped before completion.",
    );
    return workspace;
  }

  async prepareSearchReadyApplications(
    candidateId?: string,
    applicationTargetOverride?: number,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(candidateId);
    const workspace = candidateId
      ? await this.getCandidate(candidateId)
      : await this.get();
    if (!this.opportunityResearch?.assess)
      throw new Error("Evidence matching is not configured");
    if (!this.opportunityResearch.inspectApplications)
      throw new Error("Live application-form inspection is not configured");
    if (!this.coverLetterWriter)
      throw new Error("Cover letter generation is not configured");
    const applicationJobIds = new Set(
      workspace.applications.map((application) => application.jobId),
    );
    const candidates = workspace.searchReadyOpportunities.filter(
      (job) => !applicationJobIds.has(job.id),
    );
    if (candidates.length === 0)
      throw new Error("There are no search-verified vacancies ready for matching");

    const applicationTarget = Math.min(
      applicationTargetOverride ?? workspace.searchConfig.applicationTarget,
      candidates.length,
    );
    workspace.jobHistory = normalizeJobHistory(workspace);
    let pendingProgressWrite = Promise.resolve();
    const reportProgress = async (update: OpportunityProgressUpdate) => {
      this.assertBackgroundExecutionRunning(workspace.candidateId);
      if (update.item) await this.assignJobNumbers([update.item]);
      applyProgressUpdate(workspace, update);
      pendingProgressWrite = pendingProgressWrite.then(() =>
        this.saveCandidate(workspace),
      );
      await pendingProgressWrite;
    };
    await this.saveCandidate(workspace);
    return this.continueAfterVacancyVerification({
      workspace,
      candidates,
      existingApplicationJobs: workspace.opportunities.filter((job) =>
        workspace.applications.some(
          (application) => application.jobId === job.id,
        ),
      ),
      fallbackApplications: [],
      nextSeenJobUrls: uniqueUrls([
        ...workspace.seenJobUrls,
        ...candidates.flatMap((job) => [job.sourceUrl, job.applyUrl]),
      ]),
      reportProgress,
      waitForProgress: () => pendingProgressWrite,
      selectionLimit: applicationTarget,
    });
  }

  private async continueAfterVacancyVerification(input: {
    workspace: JobSearchWorkspace;
    candidates: JobOpportunity[];
    existingApplicationJobs: JobOpportunity[];
    fallbackApplications: ApplicationDraft[];
    nextSeenJobUrls: string[];
    selectionLimit?: number;
    reportProgress: (
      update: OpportunityProgressUpdate,
    ) => void | Promise<void>;
    waitForProgress: () => Promise<void>;
  }): Promise<JobSearchWorkspace> {
    const {
      workspace,
      candidates,
      existingApplicationJobs,
      fallbackApplications,
      nextSeenJobUrls,
      selectionLimit,
      reportProgress,
      waitForProgress,
    } = input;
    workspace.phase = "applications";
    setSearchStage(
      workspace,
      "verifying",
      workspace.searchConfig.discoveryTarget,
      candidates.length,
      `Scoring ${candidates.length} verified vacancies against required and preferred evidence.`,
    );
    await this.saveCandidate(workspace);
    const assessmentResults = this.opportunityResearch!.assess
      ? await Promise.all(
          candidates.map(async (job) => {
            await reportProgress({ item: pipelineIdentity(job), phase: "match", state: "running" });
            if (hasReusableAssessment(job)) {
              await reportProgress({
                item: pipelineIdentity(job),
                phase: "match",
                state: "passed",
                fit: job.fit,
              });
              return [job] as JobOpportunity[];
            }
            try {
              const result = await this.opportunityResearch!.assess!(workspace, [job], reportProgress);
              const assessedJob = Array.isArray(result) ? result[0] : result.opportunities[0];
              const failure = Array.isArray(result) ? undefined : result.failures[0];
              const reason =
                failure?.reason ||
                (assessedJob
                  ? undefined
                  : "Requirement matching returned no verified assessment");
              await reportProgress({
                item: pipelineIdentity(job),
                phase: "match",
                state: assessedJob ? "passed" : "failed",
                fit: assessedJob?.fit,
                reason,
              });
              return assessedJob || failure
                ? result
                : {
                    opportunities: [],
                    failures: [matchingFailureFromOpportunity(job, reason!)],
                  };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              await reportProgress({
                item: pipelineIdentity(job),
                phase: "match",
                state: "failed",
                reason,
              });
              return {
                opportunities: [],
                failures: [matchingFailureFromOpportunity(job, reason)],
              };
            }
          }),
        )
      : candidates.map((job) => [job] as JobOpportunity[]);
    const assessed: JobOpportunity[] = [];
    const assessmentFailures: JobResearchFailure[] = [];
    for (const result of assessmentResults) {
      if (Array.isArray(result)) assessed.push(...result);
      else {
        assessed.push(...result.opportunities);
        assessmentFailures.push(...result.failures);
      }
    }
    await this.assignJobNumbers([...assessed, ...assessmentFailures]);
    mergeResearchFailures(workspace, assessmentFailures);
    const ranked = mergeUniqueJobs(assessed).sort((a, b) => b.fit - a.fit);
    const selectedJobs = selectPhase2ApplicationPortfolio(
      ranked,
      selectionLimit ?? workspace.searchConfig.applicationTarget,
    );
    return this.prepareSelectedApplications({
      workspace,
      ranked,
      selectedJobs,
      existingApplicationJobs,
      fallbackApplications,
      nextSeenJobUrls,
      reportProgress,
      waitForProgress,
    });
  }

  private async prepareSelectedApplications(input: {
    workspace: JobSearchWorkspace;
    ranked: JobOpportunity[];
    selectedJobs: JobOpportunity[];
    existingApplicationJobs: JobOpportunity[];
    fallbackApplications: ApplicationDraft[];
    nextSeenJobUrls: string[];
    reportProgress: (
      update: OpportunityProgressUpdate,
    ) => void | Promise<void>;
    waitForProgress: () => Promise<void>;
  }): Promise<JobSearchWorkspace> {
    const {
      workspace,
      ranked,
      selectedJobs,
      existingApplicationJobs,
      fallbackApplications,
      nextSeenJobUrls,
      reportProgress,
      waitForProgress,
    } = input;
    const selectedIds = new Set(selectedJobs.map((job) => job.id));
    await Promise.all(
      ranked.map((job) =>
        reportProgress({
          item: pipelineIdentity(job),
          phase: "application",
          state: selectedIds.has(job.id) ? "selected" : "bench",
          fit: job.fit,
        }),
      ),
    );
    setSearchStage(
      workspace,
      "filling",
      workspace.searchConfig.applicationTarget,
      0,
      `Preparing application forms for the top ${selectedJobs.length} matched ${selectedJobs.length === 1 ? "job" : "jobs"}; ${Math.max(0, ranked.length - selectedJobs.length)} remain as scored replacements.`,
    );
    await this.saveCandidate(workspace);
    let inspected: {
      applications: ApplicationDraft[];
      failures: JobResearchFailure[];
    };
    if (this.opportunityResearch!.inspectApplications) {
      const inspectionResults = await Promise.all(
        selectedJobs.map(async (job) => {
          let result: {
            applications: ApplicationDraft[];
            failures: JobResearchFailure[];
          };
          try {
            result = await this.opportunityResearch!.inspectApplications!(
              workspace,
              [job],
              reportProgress,
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result = {
              applications: [],
              failures: [applicationFailureFromOpportunity(job, reason)],
            };
          }
          const application = result.applications.find(
            (candidate) => candidate.jobId === job.id,
          );
          const failure = result.failures.find(
            (candidate) =>
              normalizeUrl(candidate.sourceUrl) === normalizeUrl(job.sourceUrl) ||
              normalizeUrl(candidate.applyUrl) === normalizeUrl(job.applyUrl),
          );
          const passed = application?.liveFormValidated === true;
          const reason = passed
            ? undefined
            : failure?.reason ||
              (application
                ? applicationVerificationBlockReason(application)
                : "Application form inspection returned no result for this vacancy");
          await reportProgress({
            item: pipelineIdentity(job),
            phase: "application",
            state: passed ? "passed" : "failed",
            reason,
          });
          if (!passed && result.failures.length === 0)
            result.failures.push(applicationFailureFromOpportunity(job, reason!));
          return result;
        }),
      );
      inspected = {
        applications: inspectionResults.flatMap((result) => result.applications),
        failures: inspectionResults.flatMap((result) => result.failures),
      };
    } else {
      inspected = {
        applications: fallbackApplications.filter((application) =>
          selectedJobs.some((job) => job.id === application.jobId),
        ),
        failures: [],
      };
    }
    await this.assignJobNumbers(inspected.failures);
    mergeResearchFailures(workspace, inspected.failures);
    normalizeApplications(inspected.applications);
    const verifiableApplications = inspected.applications.filter(
      applicationIsPreparedForVerification,
    );
    const blockedApplications = inspected.applications.filter(
      (application) => !applicationIsPreparedForVerification(application),
    );
    await Promise.all([
      ...verifiableApplications.map((application) => {
        const job = selectedJobs.find((item) => item.id === application.jobId);
        return job
          ? reportProgress({
              item: pipelineIdentity(job),
              phase: "application",
              state: "passed",
            })
          : undefined;
      }),
      ...blockedApplications.map((application) => {
        const job = selectedJobs.find((item) => item.id === application.jobId);
        return job
          ? reportProgress({
              item: pipelineIdentity(job),
              phase: "application",
              state: "failed",
              reason: applicationVerificationBlockReason(application),
            })
          : undefined;
      }),
    ]);
    setSearchStage(
      workspace,
      "filling",
      workspace.searchConfig.applicationTarget,
      verifiableApplications.length,
      `${verifiableApplications.length} of ${selectedJobs.length} employer forms mapped; independently verifying grounded answers.`,
    );
    await this.saveCandidate(workspace);
    workspace.opportunities = mergeUniqueJobs(existingApplicationJobs, ranked).sort(
      (a, b) => b.fit - a.fit,
    );
    workspace.applications.push(...inspected.applications);
    await Promise.all(
      blockedApplications.map(async (application) => {
        const job = workspace.opportunities.find(
          (item) => item.id === application.jobId,
        );
        if (!job) return;
        await reportProgress({
          item: pipelineIdentity(job),
          phase: "application_verification",
          state: "failed",
          reason: applicationVerificationBlockReason(application),
        });
      }),
    );
    let failedApplicationVerifications = 0;
    const draftBatches = await Promise.all(
      verifiableApplications.map(async (application) => {
        const job = workspace.opportunities.find((item) => item.id === application.jobId);
        if (job)
          await reportProgress({
            item: pipelineIdentity(job),
            phase: "application_verification",
            state: "running",
          });
        try {
          const drafts = await this.coverLetterWriter!.draft(workspace, [application.id]);
          if (job)
            await reportProgress({
              item: pipelineIdentity(job),
              phase: "application_verification",
              state: "passed",
            });
          return drafts;
        } catch (error) {
          failedApplicationVerifications += 1;
          if (job)
            await reportProgress({
              item: pipelineIdentity(job),
              phase: "application_verification",
              state: "failed",
              reason: error instanceof Error ? error.message : String(error),
            });
          return [];
        }
      }),
    );
    for (const drafts of draftBatches) {
      applyGeneratedDrafts(workspace, drafts, drafts.map((draft) => draft.applicationId));
      for (const draft of drafts)
        requireApplication(workspace, draft.applicationId).addedBy = "agent";
    }
    workspace.jobHistory = normalizeJobHistory(workspace);
    setSearchStage(
      workspace,
      "ready",
      workspace.searchConfig.applicationTarget,
      verifiableApplications.length - failedApplicationVerifications,
      `${verifiableApplications.length - failedApplicationVerifications} of ${selectedJobs.length} applications are prepared and independently verified. ${failedApplicationVerifications} failed answer verification and ${blockedApplications.length} require form-mapping review.`,
    );
    workspace.seenJobUrls = nextSeenJobUrls;
    await waitForProgress();
    await this.saveCandidate(workspace);
    return workspace;
  }

  async resetJobList(candidateId = CANDIDATE_ID): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    if (this.activeFindMore.has(workspace.candidateId))
      throw new Error("Wait for the active job search to finish before resetting the list");
    workspace.opportunities = [];
    workspace.searchReadyOpportunities = [];
    workspace.applications = [];
    workspace.rejectedOpportunities = [];
    workspace.searchValidationIssues = [];
    workspace.jobHistory = [];
    workspace.seenJobUrls = [];
    workspace.searchProgress = undefined;
    workspace.discoveryNeedsRun = true;
    workspace.phase = "search";
    await new VacancySourceInventory(
      this.root,
      workspace.candidateId,
    ).clear();
    await this.resetJobNumberRegistry();
    await this.saveCandidate(workspace);
    return workspace;
  }

  async resetUserCompletely(
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    if (
      this.activeFindMore.has(candidateId) ||
      this.activeAnalyses.has(candidateId) ||
      this.activeProfileSourceSync.has(candidateId)
    )
      throw new Error(
        "Wait for the active profile or job-search work to finish before resetting the user",
      );

    await this.candidateWrites.get(candidateId);
    await this.get(candidateId);

    const localFullReset =
      candidateId === CANDIDATE_ID &&
      this.workspaceStore instanceof FileWorkspaceStore;
    await Promise.all([
      rm(
        localFullReset
          ? this.directory
          : path.join(this.directory, candidateId),
        { recursive: true, force: true },
      ),
      rm(
        localFullReset
          ? this.filesDirectory
          : path.join(this.filesDirectory, candidateId),
        { recursive: true, force: true },
      ),
      rm(
        localFullReset
          ? this.runsDirectory
          : path.join(this.runsDirectory, candidateId),
        { recursive: true, force: true },
      ),
      rm(
        localFullReset
          ? this.sourceSnapshotsDirectory
          : path.join(this.sourceSnapshotsDirectory, candidateId),
        { recursive: true, force: true },
      ),
      rm(
        localFullReset
          ? this.analysisCheckpointsDirectory
          : path.join(this.analysisCheckpointsDirectory, candidateId),
        { recursive: true, force: true },
      ),
      this.workspaceStore.delete(candidateId),
    ]);
    await Promise.all([
      mkdir(this.directory, { recursive: true }),
      mkdir(this.filesDirectory, { recursive: true }),
      mkdir(this.runsDirectory, { recursive: true }),
      mkdir(this.sourceSnapshotsDirectory, { recursive: true }),
      mkdir(this.analysisCheckpointsDirectory, { recursive: true }),
    ]);

    this.candidateCache.delete(candidateId);
    this.requestedAnalyses.delete(candidateId);
    this.requestedProfileSourceSync.delete(candidateId);
    if (candidateId === CANDIDATE_ID) await this.resetJobNumberRegistry();

    const workspace = emptyWorkspace(candidateId, {
      name: "",
      email: "",
      location: "",
    });
    if (this.isExecutionStopped(candidateId))
      workspace.backgroundExecution = {
        state: "stopped",
        stoppedAt: new Date().toISOString(),
      };
    await this.saveCandidate(workspace);
    return workspace;
  }

  async startFindMoreApplications(
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    return this.startPrepareApplications(
      workspace.searchConfig.applicationTarget,
      true,
      candidateId,
    );
  }

  /**
   * Reopen every persisted discovery record with the current vacancy validator.
   * This deliberately stops before evidence matching or application preparation.
   */
  async revalidateSearchHistory(
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(candidateId);
    if (!this.opportunityResearch?.revalidate)
      throw new Error("Live vacancy revalidation is not configured");
    const workspace = await this.get(candidateId);
    workspace.jobHistory = normalizeJobHistory(workspace);
    const records = workspace.jobHistory.filter((item) =>
      validHttpUrl(item.sourceUrl),
    );
    if (!records.length)
      throw new Error("There are no persisted search records to revalidate");

    const replayedIds = new Set(records.map((item) => item.id));
    const replayedUrls = new Set(records.map((item) => normalizeUrl(item.sourceUrl)));
    const inputs = records.map((item) => replayOpportunity(item));
    const previousStage = workspace.searchProgress?.stage;
    workspace.searchProgress = {
      ...(workspace.searchProgress ?? {
        target: records.length,
        found: 0,
        items: [],
      }),
      stage: "verifying",
      target: records.length,
      found: 0,
      error: undefined,
      activity: `Revalidating 0 of ${records.length} stored search records with the current vacancy logic. Matching and applications will not run.`,
      updatedAt: new Date().toISOString(),
      items: structuredClone(workspace.jobHistory),
      events: [
        ...(workspace.searchProgress?.events ?? []),
        progressEvent(
          `Started a validation-only replay of ${records.length} stored search records.`,
        ),
      ].slice(-10),
    };
    await this.saveCandidate(workspace);

    let completed = 0;
    let writes = Promise.resolve();
    const terminalUpdates = new Set<string>();
    const reportProgress = async (update: OpportunityProgressUpdate) => {
      applyProgressUpdate(workspace, update);
      if (
        update.phase === "validation" &&
        (update.state === "passed" || update.state === "failed")
      ) {
        const key = `${update.item?.id ?? ""}:${update.state}`;
        if (!terminalUpdates.has(key)) {
          terminalUpdates.add(key);
          completed += 1;
        }
        workspace.searchProgress!.found = completed;
        workspace.searchProgress!.activity =
          `Revalidated ${completed} of ${records.length} stored search records. Matching and applications remain unchanged.`;
        if (completed % 10 === 0) {
          writes = writes.then(() => this.saveCandidate(workspace));
          await writes;
        }
      }
    };

    const replay = await this.opportunityResearch.revalidate(
      workspace,
      inputs,
      reportProgress,
      { expansionLimit: 10 },
    );
    await writes;
    await this.assignJobNumbers([
      ...replay.opportunities,
      ...replay.failures,
    ]);

    const isReplayedValidationFailure = (failure: JobResearchFailure) =>
      (failure.stage === "vacancy_validation" || failure.stage === "expired") &&
      (replayedIds.has(failure.id) ||
        replayedUrls.has(normalizeUrl(failure.sourceUrl)));
    workspace.rejectedOpportunities = workspace.rejectedOpportunities.filter(
      (failure) => !isReplayedValidationFailure(failure),
    );
    workspace.searchValidationIssues = workspace.searchValidationIssues.filter(
      (failure) => !isReplayedValidationFailure(failure),
    );
    mergeResearchFailures(workspace, replay.failures);

    const existingApplicationJobIds = new Set(
      workspace.applications.map((application) => application.jobId),
    );
    const existingAssessedUrls = new Set(
      workspace.opportunities.flatMap((job) => [
        normalizeUrl(job.sourceUrl),
        normalizeUrl(job.applyUrl),
      ]),
    );
    const retainedReady = workspace.searchReadyOpportunities.filter(
      (job) =>
        !replayedUrls.has(normalizeUrl(job.sourceUrl)) &&
        !replayedUrls.has(normalizeUrl(job.applyUrl)),
    );
    const newlyReady = replay.opportunities.filter(
      (job) =>
        !existingApplicationJobIds.has(job.id) &&
        !existingAssessedUrls.has(normalizeUrl(job.sourceUrl)) &&
        !existingAssessedUrls.has(normalizeUrl(job.applyUrl)),
    );
    workspace.searchReadyOpportunities = mergeUniqueJobs(
      retainedReady,
      newlyReady,
    );

    const outcomeIds = new Set([
      ...replay.opportunities.map((job) => job.id),
      ...replay.failures.map((failure) => failure.id),
    ]);
    for (const job of replay.opportunities) {
      const previous = workspace.jobHistory.find(
        (item) =>
          item.id === job.id ||
          normalizeUrl(item.sourceUrl) === normalizeUrl(job.sourceUrl),
      );
      upsertJobHistory(workspace, {
        ...pipelineIdentity(job),
        validation: "passed",
        match: previous?.match ?? "waiting",
        application: previous?.application ?? "waiting",
        applicationVerification:
          previous?.applicationVerification ?? "waiting",
        applicationReady: previous?.applicationReady,
        fit: previous?.fit,
      });
    }
    for (const failure of replay.failures) {
      const previous = workspace.jobHistory.find(
        (item) => item.id === failure.id,
      );
      upsertJobHistory(workspace, {
        id: failure.id,
        jobNumber: failure.jobNumber,
        company: failure.company,
        title: failure.title,
        sourceUrl: failure.sourceUrl,
        validation: "failed",
        match: previous?.match ?? "waiting",
        application: previous?.application ?? "waiting",
        applicationVerification:
          previous?.applicationVerification ?? "waiting",
        applicationReady: previous?.applicationReady,
        fit: previous?.fit,
        reason: failure.reason,
        validationDisposition: failure.disposition,
      });
    }
    const expandedSources = records.filter(
      (record) => !outcomeIds.has(record.id),
    );
    for (const source of expandedSources)
      upsertJobHistory(workspace, {
        ...source,
        validation: "bench",
        reason:
          "Generic vacancy source expanded into concrete jobs during validation replay.",
        validationDisposition: "source_page",
      });

    workspace.seenJobUrls = uniqueUrls([
      ...workspace.seenJobUrls,
      ...replay.opportunities.flatMap((job) => [job.sourceUrl, job.applyUrl]),
      ...replay.failures.flatMap((failure) => [
        failure.sourceUrl,
        failure.applyUrl,
      ]),
    ]);
    workspace.searchProgress = {
      ...workspace.searchProgress!,
      stage: previousStage === "stopped" ? "stopped" : "ready",
      target: records.length,
      found: replay.opportunities.length,
      error: undefined,
      activity:
        `Validation replay complete: ${records.length} stored records checked, ` +
        `${replay.opportunities.length} concrete live vacancies returned, ` +
        `${replay.failures.length} failed, and ${expandedSources.length} generic sources expanded.`,
      updatedAt: new Date().toISOString(),
      events: [
        ...(workspace.searchProgress?.events ?? []),
        progressEvent(
          `Validation-only replay completed: ${replay.opportunities.length} live vacancies, ${replay.failures.length} failures, ${expandedSources.length} expanded sources.`,
        ),
      ].slice(-10),
    };
    finalizePipelineHistory(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }

  async findMoreApplications(
    candidateId?: string,
    applicationTargetOverride?: number,
  ): Promise<JobSearchWorkspace> {
    const workspace = candidateId
      ? await this.getCandidate(candidateId)
      : await this.get();
    return this.prepareApplications(
      workspace.candidateId,
      applicationTargetOverride ?? workspace.searchConfig.applicationTarget,
    );
  }

  async updateSearchConfig(input: {
    discoveryTarget?: number;
    applicationTarget?: number;
  }, candidateId = CANDIDATE_ID): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    workspace.searchConfig = {
      discoveryTarget: Math.max(
        5,
        Math.min(50, Math.round(input.discoveryTarget ?? workspace.searchConfig.discoveryTarget)),
      ),
      applicationTarget: Math.max(
        1,
        Math.min(10, Math.round(input.applicationTarget ?? workspace.searchConfig.applicationTarget)),
      ),
    };
    await this.saveCandidate(workspace);
    return workspace;
  }

  async addOpportunity(
    input: Partial<JobOpportunity> &
      Pick<JobOpportunity, "company" | "title" | "applyUrl">,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    if (
      !input.company?.trim() ||
      !input.title?.trim() ||
      !validHttpUrl(input.applyUrl)
    )
      throw new Error(
        "Company, title and a valid application URL are required",
      );
    const workspace = await this.get(candidateId);
    const id = `custom-${randomUUID().slice(0, 8)}`;
    const opportunity: JobOpportunity = {
      id,
      company: input.company.trim(),
      title: input.title.trim(),
      location: input.location?.trim() || "Not specified",
      workplace: input.workplace?.trim() || "Not specified",
      compensation: input.compensation?.trim() || "Not disclosed",
      sourceUrl: input.sourceUrl || input.applyUrl,
      applyUrl: input.applyUrl,
      capturedAt: new Date().toISOString().slice(0, 10),
      fit: input.fit ?? 0,
      summary:
        input.summary?.trim() ||
        "Added by the candidate for evidence mapping and application preparation.",
      requirements: input.requirements ?? [],
      requirementMatches: input.requirementMatches ?? [],
      strengths: input.strengths ?? [],
      gaps: input.gaps ?? [
        "Role requirements have not yet been independently mapped",
      ],
    };
    await this.assignJobNumbers([opportunity]);
    workspace.opportunities.push(opportunity);
    const application = applicationFor(opportunity, workspace);
    application.addedBy = "user";
    workspace.applications.push(application);
    if (!this.coverLetterWriter)
      throw new Error("Cover letter generation is not configured");
    applyGeneratedDrafts(
      workspace,
      await this.coverLetterWriter.draft(workspace, [application.id]),
      [application.id],
    );
    workspace.jobHistory = normalizeJobHistory(workspace);
    workspace.phase = "applications";
    await this.saveCandidate(workspace);
    return workspace;
  }

  async promoteOpportunity(
    jobId: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const existingApplication = workspace.applications.find(
      (application) => application.jobId === jobId,
    );
    if (existingApplication) {
      existingApplication.addedBy = "user";
      workspace.phase = "applications";
      await this.saveCandidate(workspace);
      return workspace;
    }

    const failure = [
      ...workspace.searchValidationIssues,
      ...workspace.rejectedOpportunities,
    ].find((item) => item.id === jobId);
    let opportunity = [
      ...workspace.opportunities,
      ...workspace.searchReadyOpportunities,
    ].find((item) => item.id === jobId);
    if (!opportunity && failure) {
      opportunity = {
        id: failure.id,
        jobNumber: failure.jobNumber,
        company: failure.company,
        title: failure.title,
        location: failure.location || "Not specified",
        workplace: "Not specified",
        compensation: "Not disclosed",
        sourceUrl: failure.sourceUrl,
        applyUrl: failure.applyUrl,
        capturedAt: failure.capturedAt.slice(0, 10),
        fit: 0,
        summary: `Added manually after the automated pipeline reported: ${failure.reason}`,
        description: failure.reason,
        requirements: [],
        requirementMatches: [],
        strengths: [],
        gaps: [failure.reason],
      };
      await this.assignJobNumbers([opportunity]);
      workspace.opportunities.push(opportunity);
    }
    if (!opportunity) throw new Error("The selected job is no longer available");

    let application: ApplicationDraft | undefined;
    if (this.opportunityResearch?.inspectApplications) {
      try {
        const inspected = await this.opportunityResearch.inspectApplications(
          workspace,
          [opportunity],
        );
        application = inspected.applications.find(
          (candidate) => candidate.jobId === opportunity!.id,
        );
      } catch {
        // Manual promotion must still produce a manageable draft when the
        // employer form cannot be inspected automatically.
      }
    }
    application ??= applicationFor(opportunity, workspace);
    application.addedBy = "user";
    normalizeApplications([application]);
    workspace.applications.push(application);

    if (this.coverLetterWriter) {
      try {
        const drafts = await this.coverLetterWriter.draft(workspace, [
          application.id,
        ]);
        applyGeneratedDrafts(workspace, drafts, [application.id]);
      } catch {
        // The draft remains in Applications for manual completion.
      }
    }
    workspace.searchReadyOpportunities =
      workspace.searchReadyOpportunities.filter((item) => item.id !== jobId);
    workspace.searchValidationIssues = workspace.searchValidationIssues.filter(
      (item) => item.id !== jobId,
    );
    workspace.rejectedOpportunities = workspace.rejectedOpportunities.filter(
      (item) => item.id !== jobId,
    );
    workspace.jobHistory = normalizeJobHistory(workspace);
    upsertJobHistory(workspace, {
      ...pipelineIdentity(opportunity),
      validation: "passed",
      match: "selected",
      application: "selected",
      applicationVerification: "waiting",
      applicationReady: application.status === "ready_to_send",
      fit: opportunity.fit,
      reason: "Added manually to the candidate's application list",
    });
    workspace.phase = "applications";
    await this.saveCandidate(workspace);
    return workspace;
  }

  async updateApplication(
    id: string,
    body: { coverLetter?: string; fields?: Record<string, string> },
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const workspace = await this.get(candidateId);
    const application = requireApplication(workspace, id);
    if (typeof body.coverLetter === "string")
      setApplicationCoverLetter(application, body.coverLetter, "user");
    for (const field of application.formFields)
      if (body.fields && field.id in body.fields) {
        field.value = body.fields[field.id];
        field.source = "user";
        field.confidence = 100;
        const key = reusableCandidateKey(field);
        if (key && REUSABLE_CANDIDATE_KEYS.has(key)) {
          if (field.value.trim()) workspace.sharedAnswers[key] = field.value.trim();
          else delete workspace.sharedAnswers[key];
          syncProfileFact(workspace.profile, key, field.value);
          for (const draft of workspace.applications)
            for (const sibling of draft.formFields)
              if (
                sibling !== field &&
                reusableCandidateKey(sibling) === key &&
                sibling.type !== "file"
              ) {
                const compatible = compatibleCandidateValue(sibling, field.value);
                sibling.value = compatible;
                sibling.source = compatible ? "user" : "user";
                sibling.confidence = compatible ? 100 : 0;
              }
        }
      }
    for (const draft of workspace.applications) {
      refreshApplicationReadiness(draft);
    }
    await this.saveCandidate(workspace);
    return workspace;
  }

  async refineCoverLetter(
    id: string,
    message: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const request = message.trim();
    if (!request) throw new Error("Enter a cover letter adjustment");
    if (!this.coverLetterWriter)
      throw new Error("Cover letter refinement is not configured");
    const workspace = await this.get(candidateId);
    const application = requireApplication(workspace, id);
    if (application.outcome === "applied_waiting")
      throw new Error("Restore the applied application before editing it");
    if (!application.formFields.some(isCoverLetterField))
      throw new Error("This employer form does not request a cover letter");
    const result = await this.coverLetterWriter.refine(
      workspace,
      application,
      request,
    );
    const createdAt = new Date().toISOString();
    application.coverLetterThreadId = result.threadId;
    application.coverLetterChat.push(
      {
        id: randomUUID(),
        role: "user",
        content: request,
        createdAt,
      },
      {
        id: randomUUID(),
        role: "assistant",
        content: result.assistantMessage.trim(),
        createdAt: new Date().toISOString(),
      },
    );
    setApplicationCoverLetter(application, result.coverLetter);
    application.updatedAt = new Date().toISOString();
    await this.saveCandidate(workspace);
    return workspace;
  }

  async refineApplicationField(
    id: string,
    fieldId: string,
    message: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    const request = message.trim();
    if (!request) throw new Error("Enter an answer adjustment");
    if (!this.coverLetterWriter?.refineAnswer)
      throw new Error("Application answer refinement is not configured");
    const workspace = await this.get(candidateId);
    const application = requireApplication(workspace, id);
    if (application.outcome === "applied_waiting")
      throw new Error("Restore the applied application before editing it");
    const field = application.formFields.find((item) => item.id === fieldId);
    if (!field) throw new Error("Unknown application field");
    if (
      (field.type !== "textarea" && field.type !== "text") ||
      isCoverLetterField(field)
    )
      throw new Error("Only open-ended application answers can be adjusted here");
    if (isProtectedApplicationField(field))
      throw new Error("This field requires a candidate-confirmed answer");
    const result = await this.coverLetterWriter.refineAnswer(
      workspace,
      application,
      field,
      request,
    );
    const value = result.value.trim();
    const evidence = result.evidenceBasis.trim();
    if (!value || !evidence)
      throw new Error("The available candidate evidence did not support a revised answer");
    field.value = value;
    field.evidence = evidence;
    field.source = "generated";
    field.confidence = 85;
    refreshApplicationReadiness(application);
    await this.saveCandidate(workspace);
    return workspace;
  }

  async tailorApplicationCv(
    id: string,
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    if (!this.coverLetterWriter?.tailorCv)
      throw new Error("CV tailoring is not configured");
    const workspace = await this.get(candidateId);
    const application = requireApplication(workspace, id);
    if (application.outcome === "applied_waiting")
      throw new Error("Restore the applied application before tailoring its CV");
    if (!workspace.finalCv.trim())
      throw new Error("Upload a readable CV before generating a tailored version");
    const result = await this.coverLetterWriter.tailorCv(
      workspace,
      application,
    );
    const content = result.content.trim();
    if (!content)
      throw new Error("The CV tailoring step returned an empty document");
    const fileName = tailoredCvFileName(workspace, application);
    const directory = path.join(
      this.filesDirectory,
      workspace.candidateId,
      "tailored",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      tailoredCvPath(this.filesDirectory, workspace.candidateId, application.id),
      await renderTailoredCvDocx(content),
    );
    application.tailoredCv = {
      status: "ready",
      content,
      changeSummary: result.changeSummary
        .map((item) => item.trim())
        .filter(Boolean),
      fileName,
      generatedAt: new Date().toISOString(),
    };
    application.updatedAt = new Date().toISOString();
    await this.saveCandidate(workspace);
    return workspace;
  }

  async tailoredCvFile(
    candidateId: string,
    applicationId: string,
  ): Promise<{ file: string; name: string; mimeType: string; size: number }> {
    const workspace = await this.getCandidate(candidateId);
    const application = requireApplication(workspace, applicationId);
    if (application.tailoredCv?.status !== "ready")
      throw new Error("A tailored CV has not been generated for this application");
    const file = tailoredCvPath(
      this.filesDirectory,
      candidateId,
      application.id,
    );
    const info = await stat(file);
    return {
      file,
      name: application.tailoredCv.fileName,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: info.size,
    };
  }

  async setApplicationOutcome(
    id: string,
    outcome: ApplicationDraft["outcome"],
    candidateId = CANDIDATE_ID,
  ): Promise<JobSearchWorkspace> {
    if (
      outcome !== undefined &&
      outcome !== "rejected_by_user" &&
      outcome !== "unsuccessful" &&
      outcome !== "applied_waiting"
    )
      throw new Error("Unknown application outcome");
    const workspace = await this.get(candidateId);
    const application = requireApplication(workspace, id);
    if (outcome) application.outcome = outcome;
    else delete application.outcome;
    application.updatedAt = new Date().toISOString();
    await this.saveCandidate(workspace);
    return workspace;
  }

  async resolveApplicationByUrl(
    url: string,
    candidateId = CANDIDATE_ID,
  ): Promise<{ candidateId: string; applicationId: string } | null> {
    const normalized = normalizeUrl(url);
    const workspace = await this.getCandidate(candidateId);
    const app = workspace.applications.find(
      (item) =>
        normalizeUrl(
          workspace.opportunities.find((job) => job.id === item.jobId)
            ?.applyUrl ?? "",
        ) === normalized,
    );
    if (app) return { candidateId, applicationId: app.id };
    return null;
  }

  async autofillByUrl(url: string, candidateId = CANDIDATE_ID): Promise<{
    candidateId: string;
    applicationId: string;
    fields: JobSearchWorkspace["applications"][number]["formFields"];
    cv?: { name: string; url: string };
  } | null> {
    const resolved = await this.resolveApplicationByUrl(url, candidateId);
    if (!resolved) return null;
    const workspace = await this.getCandidate(resolved.candidateId);
    const application = requireApplication(workspace, resolved.applicationId);
    const source = workspace.sources.find(
      (item) => item.kind === "cv" && item.originalFile,
    );
    const tailoredCv =
      application.tailoredCv?.status === "ready"
        ? await this.tailoredCvFile(
            workspace.candidateId,
            application.id,
          ).catch(() => undefined)
        : undefined;
    return {
      ...resolved,
      fields: application.formFields,
      cv: tailoredCv
        ? {
            name: tailoredCv.name,
            url: `/api/job-search/applications/${application.id}/tailored-cv`,
          }
        : source
        ? {
            name: source.name,
            url: `/api/job-search/candidates/${workspace.candidateId}/sources/${source.id}/file`,
          }
        : undefined,
    };
  }

  async isAllowedEmployerHost(
    hostname: string,
    candidateId = CANDIDATE_ID,
  ) {
    const expected = hostname.trim().toLowerCase();
    if (!expected) return false;
    const workspace = await this.get(candidateId);
    return workspace.opportunities.some((job) => {
      try {
        return new URL(job.applyUrl).hostname.toLowerCase() === expected;
      } catch {
        return false;
      }
    });
  }

  private async ensureJobNumberRegistry(): Promise<JobNumberRegistry> {
    if (this.jobNumberRegistry) return this.jobNumberRegistry;
    const stored = await readFile(this.jobNumbersFile, "utf8")
      .then((value) => JSON.parse(value) as Partial<JobNumberRegistry>)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    const currentVersion = stored?.version === 2;
    const byKey = Object.fromEntries(
      Object.entries(currentVersion ? stored?.byKey ?? {} : {}).filter(
        ([, value]) => Number.isSafeInteger(value) && value > 0,
      ),
    ) as Record<string, number>;
    const highest = Math.max(0, ...Object.values(byKey));
    this.jobNumberRegistry = {
      version: 2,
      nextJobNumber: Math.max(
        highest + 1,
        currentVersion && Number.isSafeInteger(stored?.nextJobNumber)
          ? Number(stored!.nextJobNumber)
          : 1,
      ),
      byKey,
    };
    if (!stored || !currentVersion)
      await writeFile(
        this.jobNumbersFile,
        `${JSON.stringify(this.jobNumberRegistry, null, 2)}\n`,
        "utf8",
      );
    return this.jobNumberRegistry;
  }

  private async resetJobNumberRegistry(): Promise<void> {
    const registry: JobNumberRegistry = {
      version: 2,
      nextJobNumber: 1,
      byKey: {},
    };
    await this.jobNumberAllocation;
    this.jobNumberRegistry = registry;
    await writeFile(
      this.jobNumbersFile,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8",
    );
  }

  private async assignJobNumbers(items: NumberableJob[]): Promise<void> {
    if (!items.length) return;
    const allocation = this.jobNumberAllocation
      .catch(() => undefined)
      .then(async () => {
        const registry = await this.ensureJobNumberRegistry();
        const used = new Set(Object.values(registry.byKey));
        let changed = false;
        for (const item of items) {
          const keys = jobNumberKeys(item);
          const registered = keys
            .map((key) => registry.byKey[key])
            .find((value) => Number.isSafeInteger(value) && value > 0);
          let jobNumber = registered;
          if (!jobNumber && item.jobNumber && !used.has(item.jobNumber))
            jobNumber = item.jobNumber;
          if (!jobNumber) {
            while (used.has(registry.nextJobNumber)) registry.nextJobNumber += 1;
            jobNumber = registry.nextJobNumber;
            registry.nextJobNumber += 1;
            changed = true;
          }
          if (item.jobNumber !== jobNumber) item.jobNumber = jobNumber;
          used.add(jobNumber);
          if (registry.nextJobNumber <= jobNumber)
            registry.nextJobNumber = jobNumber + 1;
          for (const key of keys)
            if (registry.byKey[key] !== jobNumber) {
              registry.byKey[key] = jobNumber;
              changed = true;
            }
        }
        if (changed)
          await writeFile(
            this.jobNumbersFile,
            `${JSON.stringify(registry, null, 2)}\n`,
            "utf8",
          );
      });
    this.jobNumberAllocation = allocation;
    await allocation;
  }

  private async getCandidate(id: string): Promise<JobSearchWorkspace> {
    while (this.candidateWrites.has(id)) {
      const pending = this.candidateWrites.get(id)!;
      await pending.catch(() => undefined);
      if (this.candidateWrites.get(id) === pending) break;
    }
    const cached = this.candidateCache.get(id);
    if (cached && this.workspaceStore instanceof FileWorkspaceStore)
      return normalizeWorkspace(structuredClone(cached), id);
    const stored = await this.workspaceStore.load(id);
    if (!stored) {
      const created = emptyWorkspace(id, {
        name: "",
        email: "",
        location: "",
      });
      await this.assignJobNumbers([
        ...created.opportunities,
        ...created.rejectedOpportunities,
        ...created.searchValidationIssues,
        ...(created.searchProgress?.items ?? []),
      ]);
      await this.saveCandidate(created);
      return created;
    }
    const workspace = normalizeWorkspace(stored, id);
    this.candidateCache.set(id, structuredClone(workspace));
    return workspace;
  }
  private async saveCandidate(value: JobSearchWorkspace) {
    const stoppedSnapshot = this.stoppedSnapshots.get(value.candidateId);
    if (stoppedSnapshot) value = structuredClone(stoppedSnapshot);
    repairWorkspaceJobText(value);
    value.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(value);
    const previous = this.candidateWrites.get(value.candidateId);
    const write = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.workspaceStore.save(snapshot);
        this.candidateCache.set(value.candidateId, snapshot);
      });
    this.candidateWrites.set(value.candidateId, write);
    try {
      await write;
    } finally {
      if (this.candidateWrites.get(value.candidateId) === write)
        this.candidateWrites.delete(value.candidateId);
    }
  }

  private trackSearchTask(
    workspace: JobSearchWorkspace,
    mode: BackgroundSearchOperation,
    work: Promise<JobSearchWorkspace>,
    failureActivity: string,
  ): void {
    const candidateId = workspace.candidateId;
    this.activeSearchMode.set(candidateId, mode);
    const task = work
      .then(() => undefined)
      .catch(async (error) => {
        const current = await this.getCandidate(candidateId);
        if (
          this.isExecutionStopped(candidateId) ||
          current.backgroundExecution?.state === "stopped"
        )
          return;
        current.searchProgress = {
          ...current.searchProgress!,
          stage: "failed",
          error: error instanceof Error ? error.message : String(error),
          activity: failureActivity,
          updatedAt: new Date().toISOString(),
        };
        await this.saveCandidate(current);
      })
      .finally(() => {
        this.activeFindMore.delete(candidateId);
        this.activeSearchMode.delete(candidateId);
      });
    this.activeFindMore.set(candidateId, task);
  }

  private assertBackgroundExecutionRunning(candidateId = CANDIDATE_ID): void {
    if (this.isExecutionStopped(candidateId))
      throw new Error("Background execution is stopped");
  }

  private isExecutionStopped(candidateId: string) {
    return this.stoppedCandidates.has(candidateId);
  }

  private async runCandidateAnalysis(
    workspace: JobSearchWorkspace,
  ): Promise<JobSearchWorkspace> {
    this.assertBackgroundExecutionRunning(workspace.candidateId);
    if (!this.analyzer) return this.applyLocalAnalysis(workspace);
    const sourceIdsToAnalyze = new Set(
      workspace.sources
        .filter(
          (source) =>
            source.analysisRequired ||
            source.status === "processing" ||
            (source.status === "ready" &&
              (source.insights.length === 0 || !source.knowledgePath)),
        )
        .map((source) => source.id),
    );
    workspace.intelligence.status = "analyzing";
    workspace.intelligence.error = undefined;
    workspace.intelligence.progress = undefined;
    for (const source of workspace.sources)
      if (source.status === "processing") source.error = undefined;
    await this.saveCandidate(workspace);
    try {
      const built = await buildCandidateEvidence({
        analyzer: this.analyzer,
        dataRoot: this.root,
        workspace,
        sourceIdsToAnalyze,
        onProgress: async (progress) => {
          if (this.isExecutionStopped(workspace.candidateId)) return;
          const current = await this.getCandidate(workspace.candidateId);
          current.intelligence.status = "analyzing";
          current.intelligence.progress = progress;
          await this.saveCandidate(current);
        },
        reloadWorkspace: () => this.getCandidate(workspace.candidateId),
        beforeVerification: () =>
          this.assertBackgroundExecutionRunning(workspace.candidateId),
      });
      if (this.isExecutionStopped(workspace.candidateId))
        return this.getCandidate(workspace.candidateId);
      workspace = built.workspace;
    } catch (error) {
      if (this.isExecutionStopped(workspace.candidateId))
        return this.getCandidate(workspace.candidateId);
      const detail = error instanceof Error ? error.message : String(error);
      const needsReview = error instanceof EvidenceNeedsReviewError;
      workspace = await this.getCandidate(workspace.candidateId);
      workspace.intelligence.status = "failed";
      workspace.intelligence.error = detail;
      workspace.intelligence.progress = undefined;
      for (const source of workspace.sources)
        if (source.status === "processing") {
          source.status = needsReview ? "needs_review" : "analysis_failed";
          source.error = detail;
        }
    }
    recalculate(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }

  private async drainCandidateAnalysis(candidateId: string): Promise<void> {
    while (
      !this.isExecutionStopped(candidateId) &&
      this.requestedAnalyses.delete(candidateId)
    )
      await this.runCandidateAnalysis(await this.getCandidate(candidateId));
  }

  private async applyLocalAnalysis(
    workspace: JobSearchWorkspace,
  ): Promise<JobSearchWorkspace> {
    for (const source of workspace.sources) {
      source.status = "ready";
      source.analysisRequired = false;
    }
    workspace.intelligence.status = "ready";
    advanceProfileSetupAfterAnalysis(workspace);
    recalculate(workspace);
    await this.saveCandidate(workspace);
    return workspace;
  }
}

function emptyWorkspace(
  candidateId: string,
  seed: {
    name: string;
    email: string;
    location: string;
  },
): JobSearchWorkspace {
  return {
    id: candidateId,
    candidateId,
    phase: "intake",
    updatedAt: new Date().toISOString(),
    profileCompleteness: 0,
    finalCv: "",
    profile: {
      name: seed.name,
      email: seed.email,
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: seed.location,
      headline: "",
      summary: "",
      salaryExpectation: "",
      targetLocations: "",
      workplace: "",
      employmentTypes: "",
      workAuthorization: "",
      startDate: "",
      skills: [],
      languages: [],
    },
    sources: [],
    questions: questions(),
    opportunities: [],
    searchReadyOpportunities: [],
    applications: [],
    rejectedOpportunities: [],
    searchValidationIssues: [],
    jobHistory: [],
    seenJobUrls: [],
    searchConfig: { discoveryTarget: 20, applicationTarget: 5 },
    sharedAnswers: {},
    profileSetupStep: 1,
    discoveryNeedsRun: true,
    intelligence: emptyIntelligence(),
  };
}
function normalizeWorkspace(
  workspace: JobSearchWorkspace,
  id: string,
): JobSearchWorkspace {
  workspace.id = id;
  workspace.candidateId = id;
  repairWorkspaceJobText(workspace);
  workspace.searchReadyOpportunities = workspace.searchReadyOpportunities ?? [];
  workspace.applications = workspace.applications ?? [];
  workspace.rejectedOpportunities = workspace.rejectedOpportunities ?? [];
  workspace.searchValidationIssues = workspace.searchValidationIssues ?? [];
  workspace.backgroundExecution ??= { state: "running" };
  const normalizedValidationOutcomes = mergeFailures(
    workspace.rejectedOpportunities,
    workspace.searchValidationIssues,
  ).map(normalizeSearchValidationFailure);
  workspace.rejectedOpportunities = normalizedValidationOutcomes.filter(
    (failure) => failure.disposition === "rejected",
  );
  workspace.searchValidationIssues = normalizedValidationOutcomes.filter(
    (failure) => failure.disposition !== "rejected",
  );
  if (workspace.phase === "search" && workspace.searchProgress?.stage === "ready") {
    const manualCount = workspace.searchValidationIssues.filter(
      (failure) => failure.disposition === "manual_review",
    ).length;
    const unresolvedCount = workspace.searchValidationIssues.filter(
      (failure) => failure.disposition === "unresolved",
    ).length;
    const sourcePageCount = workspace.searchValidationIssues.filter(
      (failure) => failure.disposition === "source_page",
    ).length;
    workspace.searchProgress.found = workspace.searchReadyOpportunities.length;
    workspace.searchProgress.activity = `${workspace.searchReadyOpportunities.length} vacancies are ready for matching; ${workspace.rejectedOpportunities.length} confirmed rejections, ${manualCount} manual checks, ${unresolvedCount} unresolved technical results, and ${sourcePageCount} source pages.`;
  }
  workspace.seenJobUrls = workspace.seenJobUrls ?? [
    ...workspace.opportunities.flatMap((job) => [job.sourceUrl, job.applyUrl]),
    ...workspace.rejectedOpportunities.flatMap((job) => [job.sourceUrl, job.applyUrl]),
    ...workspace.searchValidationIssues.flatMap((job) => [job.sourceUrl, job.applyUrl]),
  ].filter(Boolean);
  workspace.searchConfig = {
    discoveryTarget: Math.max(
      5,
      Math.min(50, workspace.searchConfig?.discoveryTarget ?? 20),
    ),
    applicationTarget: Math.max(
      1,
      Math.min(10, workspace.searchConfig?.applicationTarget ?? 5),
    ),
  };
  workspace.discoveryNeedsRun ??=
    !workspace.searchProgress && workspace.jobHistory.length === 0;
  workspace.sharedAnswers = workspace.sharedAnswers ?? {};
  workspace.profileSetupStep ??=
    workspace.phase !== "intake"
      ? 4
      : workspace.sources?.some((source) => source.kind === "cv")
        ? 2
        : 1;
  workspace.profile.linkedin = workspace.profile.linkedin ?? "";
  workspace.profile.github = workspace.profile.github ?? "";
  workspace.profile.website = workspace.profile.website ?? "";
  const savedLocation = workspace.sharedAnswers.current_location || "";
  if (
    savedLocation &&
    (!workspace.profile.location || workspace.profile.location.toLowerCase() === "remote")
  )
    workspace.profile.location = savedLocation;
  workspace.profile.linkedin ||= workspace.sharedAnswers.linkedin || "";
  workspace.profile.github ||= workspace.sharedAnswers.github || "";
  workspace.profile.website ||= workspace.sharedAnswers.website || "";
  workspace.profile.phone ||= workspace.sharedAnswers.phone || "";
  workspace.profile.workAuthorization ||=
    workspace.sharedAnswers.work_authorization || "";
  workspace.sharedAnswers = Object.fromEntries(
    Object.entries(workspace.sharedAnswers)
      .filter(([key]) => REUSABLE_CANDIDATE_KEYS.has(key)),
  );
  if (workspace.profile.location.trim()) {
    workspace.sharedAnswers.current_location = workspace.profile.location.trim();
    workspace.sharedAnswers.country = countryNameFromLocation(
      workspace.profile.location,
    );
    if (
      !workspace.sharedAnswers.intended_work_location?.includes(",")
    )
      workspace.sharedAnswers.intended_work_location =
        workspace.profile.location.trim();
  }
  syncSharedAnswersFromProfile(workspace);
  workspace.sources = deduplicateSources(workspace.sources ?? []);
  for (const source of workspace.sources)
    if (
      source.profileField === "linkedin" &&
      source.status === "analysis_failed" &&
      /\b999\b/.test(source.error || "")
    ) {
      source.status = "needs_review";
      source.analysisRequired = false;
      source.error = profileSourceError("linkedin", source.error || "");
    }
  workspace.profile.languages = workspace.profile.languages ?? [];
  const existingQuestions = workspace.questions ?? [];
  workspace.questions = questions().map((question) => ({
    ...question,
    answer:
      existingQuestions.find((item) => item.id === question.id)?.answer ?? "",
  }));
  const savedWorkPreference = workspace.questions.find(
    (question) => question.id === "locations",
  )?.answer;
  const normalizedWorkPreference = parseWorkLocationAnswer(
    savedWorkPreference || workspace.profile.workplace || "",
  );
  if (normalizedWorkPreference.modes.length) {
    const workLocations = normalizedWorkPreference.locations.length
      ? normalizedWorkPreference.locations
      : (workspace.profile.targetLocations || "")
          .split("|")
          .map((item) => item.trim())
          .filter(
            (item) =>
              item &&
              !["remote", "hybrid", "on-site"].includes(item.toLowerCase()),
          );
    workspace.profile.workplace = normalizedWorkPreference.modes.join(", ");
    workspace.profile.targetLocations = needsWillingWorkLocation(
      normalizedWorkPreference.modes,
    )
      ? workLocations.join(" | ")
      : "";
  }
  const savedIntelligence = workspace.intelligence;
  workspace.intelligence = {
    status: savedIntelligence?.status ?? "idle",
    threadId: savedIntelligence?.threadId,
    error: savedIntelligence?.error,
    progress: savedIntelligence?.progress,
    evidenceRun: savedIntelligence?.evidenceRun,
  };
  if (workspace.profile.phone && isYearRange(workspace.profile.phone))
    workspace.profile.phone = "";
  const phoneQuestion = workspace.questions.find((item) => item.id === "phone");
  if (phoneQuestion?.answer && isYearRange(phoneQuestion.answer))
    phoneQuestion.answer = "";
  for (const source of workspace.sources) {
    source.insights = source.insights ?? [];
    source.status = source.status ?? "ready";
    if (source.kind === "cv") {
      delete source.contentHash;
      if (source.originalFile)
        source.originalFile = { name: source.originalFile.name };
      continue;
    }
    source.contentHash = createHash("sha256")
      .update(source.content || "")
      .digest("hex");
  }
  advanceProfileSetupAfterAnalysis(workspace);
  normalizeApplications(workspace.applications);
  for (const app of workspace.applications) {
    refreshApplicationReadiness(app, false);
  }
  workspace.jobHistory = normalizeJobHistory(workspace);
  recalculate(workspace);
  return workspace;
}


function repairWorkspaceJobText(workspace: JobSearchWorkspace): void {
  workspace.opportunities = (workspace.opportunities ?? []).map((job) => ({
    ...job,
    company: repairMojibake(job.company),
    title: repairMojibake(job.title),
    location: repairMojibake(job.location),
    workplace: repairMojibake(job.workplace),
    compensation:
      normalizeCompensationText(job.compensation) || "Not disclosed",
    summary: normalizeExtractedText(job.summary),
    description: job.description
      ? normalizeExtractedText(job.description)
      : undefined,
    requirements: (job.requirements ?? []).map(repairMojibake),
    requirementMatches: (job.requirementMatches ?? []).map((requirement) => ({
      ...requirement,
      requirement: repairMojibake(requirement.requirement),
      explanation: repairMojibake(requirement.explanation),
      evidence: (requirement.evidence ?? []).map((evidence) => ({
        ...evidence,
        sourceName: repairMojibake(evidence.sourceName),
        excerpt: repairMojibake(evidence.excerpt),
      })),
    })),
    strengths: (job.strengths ?? []).map(repairMojibake),
    gaps: (job.gaps ?? []).map(repairMojibake),
  }));
  workspace.applications = (workspace.applications ?? []).map((application) => ({
    ...application,
    coverLetter: repairMojibake(application.coverLetter),
    coverLetterChat: (application.coverLetterChat ?? []).map((message) => ({
      ...message,
      content: repairMojibake(message.content),
    })),
    companyResearch: application.companyResearch
      ? {
          ...application.companyResearch,
          company: repairMojibake(application.companyResearch.company),
          overview: repairMojibake(application.companyResearch.overview),
          productsAndServices:
            application.companyResearch.productsAndServices.map(repairMojibake),
          customersAndMarkets:
            application.companyResearch.customersAndMarkets.map(repairMojibake),
          businessModel: repairMojibake(
            application.companyResearch.businessModel,
          ),
          cultureAndValues:
            application.companyResearch.cultureAndValues.map(repairMojibake),
          recentSignals:
            application.companyResearch.recentSignals.map(repairMojibake),
          tailoringAngles:
            application.companyResearch.tailoringAngles.map(repairMojibake),
          sources: application.companyResearch.sources.map((source) => ({
            ...source,
            title: repairMojibake(source.title),
            evidence: repairMojibake(source.evidence),
          })),
          error: application.companyResearch.error
            ? repairMojibake(application.companyResearch.error)
            : undefined,
        }
      : undefined,
    tailoredCv: application.tailoredCv
      ? {
          ...application.tailoredCv,
          content: repairMojibake(application.tailoredCv.content),
          changeSummary:
            application.tailoredCv.changeSummary.map(repairMojibake),
          error: application.tailoredCv.error
            ? repairMojibake(application.tailoredCv.error)
            : undefined,
        }
      : undefined,
    missingQuestions: (application.missingQuestions ?? []).map(repairMojibake),
    formFields: (application.formFields ?? []).map((field) => ({
      ...field,
      label: repairMojibake(field.label),
      value: repairMojibake(field.value),
      options: field.options?.map(repairMojibake),
      evidence: field.evidence ? repairMojibake(field.evidence) : undefined,
    })),
  }));
}
function emptyIntelligence(): JobSearchWorkspace["intelligence"] {
  return { status: "idle" };
}
function mimeTypeFromFilename(name: string) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".doc") return "application/msword";
  if (extension === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if ([".txt", ".md", ".markdown", ".rtf"].includes(extension))
    return "text/plain";
  return "application/octet-stream";
}
function deduplicateSources(sources: CandidateSource[]) {
  const unique = new Map<string, CandidateSource>();
  for (const source of sources) {
    const key = source.kind === "cv"
      ? `cv:${source.id}`
      : source.contentHash || source.content || source.url || source.id;
    const existing = unique.get(key);
    if (!existing) unique.set(key, source);
    else if (
      source.status === "ready" ||
      (source.insights?.length ?? 0) > (existing.insights?.length ?? 0)
    )
      unique.set(key, source);
  }
  return [...unique.values()];
}

function questions(): JobSearchWorkspace["questions"] {
  return [
    {
      id: "salary",
      category: "preferences",
      prompt: "What minimum compensation are you targeting?",
      rationale:
        "Optional annual minimum. Leave it blank to search without a compensation filter.",
      required: false,
      answer: "",
    },
    {
      id: "locations",
      category: "preferences",
      prompt: "Where and how do you want to work?",
      rationale:
        "Remote, hybrid and on-site searches use different location constraints.",
      required: true,
      answer: "",
    },
    {
      id: "employment",
      category: "preferences",
      prompt: "Which employment types do you accept?",
      rationale: "Select one or more arrangements.",
      required: true,
      answer: "",
    },
    {
      id: "start",
      category: "preferences",
      prompt: "When could you start?",
      rationale: "Choose immediately or a specific available date.",
      required: true,
      answer: "",
    },
    {
      id: "languages",
      category: "preferences",
      prompt: "Which languages can you work in?",
      rationale: "Language requirements are applied during job filtering.",
      required: true,
      answer: "",
    },
  ];
}

function applyAnswer(w: JobSearchWorkspace, id: string, value: string) {
  if (id === "salary") w.profile.salaryExpectation = value;
  if (id === "locations") {
    const preference = parseWorkLocationAnswer(value);
    w.profile.workplace = preference.modes.join(", ");
    w.profile.targetLocations = needsWillingWorkLocation(preference.modes)
      ? preference.locations.join(" | ")
      : "";
  }
  if (id === "employment") w.profile.employmentTypes = value;
  if (id === "start") w.profile.startDate = value;
  if (id === "languages")
    w.profile.languages = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
}
function recalculate(w: JobSearchWorkspace) {
  const required = w.questions.filter((q) => q.required);
  const basics =
    (w.profile.name.trim() ? 1 : 0) + (isValidEmail(w.profile.email) ? 1 : 0);
  w.profileCompleteness = Math.round(
    (((w.sources.some((s) => s.kind === "cv") ? 1 : 0) +
      basics +
      required.filter((q) => q.answer.trim()).length) /
      (required.length + 3)) *
      100,
  );
}

function invalidateEvidenceAnalysis(workspace: JobSearchWorkspace) {
  workspace.discoveryNeedsRun = true;
  for (const source of workspace.sources) {
    source.analysisRequired =
      source.status !== "analysis_failed" &&
      source.status !== "needs_review" &&
      Boolean(source.content?.trim());
  }
  workspace.intelligence.status = "analyzing";
  workspace.intelligence.error = undefined;
  workspace.intelligence.progress = undefined;
  delete workspace.intelligence.evidenceRun;
}

function advanceProfileSetupAfterAnalysis(workspace: JobSearchWorkspace) {
  if (!workspace.sources.some((source) => source.kind === "cv")) return;
  const evidenceReady =
    workspace.intelligence.status === "ready" &&
    !workspace.sources.some(
      (source) => source.status === "processing" || source.analysisRequired,
    );
  if (!evidenceReady) return;
  const basicsReady =
    Boolean(workspace.profile.name.trim()) &&
    isValidEmail(workspace.profile.email);
  workspace.profileSetupStep = Math.max(
    workspace.profileSetupStep ?? 1,
    basicsReady ? 3 : 2,
  ) as 2 | 3 | 4;
}

function isYearRange(value: string) {
  return /^\s*\d{4}\s*[-\u2013]\s*\d{4}\s*$/.test(value);
}
function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function requireApplication(w: JobSearchWorkspace, id: string) {
  const app = w.applications.find((item) => item.id === id);
  if (!app) throw new Error("Unknown application");
  return app;
}
function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function jobNumberKeys(job: NumberableJob) {
  const title = normalizeJobIdentityText(job.title || job.id);
  const keys = [job.sourceUrl, job.applyUrl]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => `job:${normalizeUrl(value)}|${title}`);
  return [...new Set(keys.length ? keys : [`id:${job.id}`])];
}

function normalizeJobIdentityText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueUrls(values: string[]) {
  const byNormalized = new Map<string, string>();
  for (const value of values)
    if (value?.trim()) byNormalized.set(normalizeUrl(value), value.trim());
  return [...byNormalized.values()];
}

function replayOpportunity(item: SearchPipelineItem): JobOpportunity {
  return {
    id: item.id,
    jobNumber: item.jobNumber,
    company: item.company,
    title: item.title,
    location: "Not specified",
    workplace: "Not specified",
    compensation: "Not disclosed",
    sourceUrl: item.sourceUrl,
    applyUrl: item.sourceUrl,
    capturedAt: new Date().toISOString(),
    fit: 0,
    summary: "Persisted search record queued for validation-only replay.",
    description: "",
    requirements: [],
    requirementMatches: [],
    strengths: [],
    gaps: [],
  };
}

function applicationRefillRoundLimit() {
  const configured = Number(process.env.ROLEGAIN_MAX_REFILL_ROUNDS);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(20, Math.round(configured)))
    : 4;
}

function applicationMinimumFit() {
  const configured = Number(process.env.ROLEGAIN_MIN_APPLICATION_FIT);
  return Number.isFinite(configured)
    ? Math.max(0, Math.min(100, configured))
    : 35;
}

function preparedVerifiedJobIds(workspace: JobSearchWorkspace) {
  return new Set(
    workspace.applications
      .filter((application) => application.addedBy === "agent")
      .map((application) => application.jobId),
  );
}

function mergeUniqueJobs(...groups: JobOpportunity[][]) {
  const byUrl = new Map<string, JobOpportunity>();
  for (const job of groups.flat()) {
    const key = [
      normalizeJobIdentityText(job.company),
      normalizeJobIdentityText(job.title),
      normalizeJobIdentityText(job.location),
    ].join("::");
    const existing = byUrl.get(key);
    const preferred =
      !existing ||
      (job.opportunityConfidence ?? 0) >= (existing.opportunityConfidence ?? 0)
        ? job
        : existing;
    byUrl.set(key, {
      ...preferred,
      jobNumber: preferred.jobNumber ?? existing?.jobNumber ?? job.jobNumber,
      discoveryProvenance: [
        ...new Map(
          [...(existing?.discoveryProvenance || []), ...(job.discoveryProvenance || [])].map(
            (item) => [`${item.wave}:${item.sourceClass}:${item.query}`, item],
          ),
        ).values(),
      ],
    });
  }
  return [...byUrl.values()];
}

function hasReusableAssessment(job: JobOpportunity) {
  return Number.isFinite(job.fit) && job.requirementMatches.length > 0;
}

export function discoveryLimitAfterBenchValidation(input: {
  remainingApplications: number;
  reusableOpenJobs: number;
  configuredDiscoveryTarget: number;
  firstBatch: boolean;
  refillRound: number;
}) {
  const remainingApplications = Math.max(
    0,
    Math.floor(input.remainingApplications),
  );
  const reusableOpenJobs = Math.max(0, Math.floor(input.reusableOpenJobs));
  const shortfall = Math.max(0, remainingApplications - reusableOpenJobs);
  if (shortfall === 0) return 0;
  if (input.firstBatch && input.refillRound === 0)
    return Math.max(1, Math.floor(input.configuredDiscoveryTarget));
  return Math.max(1, shortfall * 4);
}

export function selectPhase2ApplicationPortfolio(
  ranked: JobOpportunity[],
  limit: number,
) {
  return ranked
    .filter((job) => job.fit >= applicationMinimumFit())
    .slice(0, Math.max(0, limit));
}

function mergeFailures(...groups: JobResearchFailure[][]) {
  const byKey = new Map<string, JobResearchFailure>();
  for (const failure of groups.flat()) {
    const key = `${normalizeUrl(failure.sourceUrl)}:${failure.stage}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...failure,
      jobNumber: failure.jobNumber ?? existing?.jobNumber,
    });
  }
  return [...byKey.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** Collapse duplicate board and ATS URLs before revalidation. */
export function coalesceSearchVerificationSeeds(
  seeds: JobOpportunity[],
): JobOpportunity[] {
  const groups: JobOpportunity[][] = [];
  for (const seed of seeds) {
    const matchingIndexes = groups
      .map((group, index) =>
        group.some((existing) => sameSearchVacancy(seed, existing))
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (matchingIndexes.length === 0) {
      groups.push([seed]);
      continue;
    }
    const primary = matchingIndexes[0];
    groups[primary].push(seed);
    for (const index of matchingIndexes.slice(1).reverse())
      groups[primary].push(...groups.splice(index, 1)[0]);
  }
  return groups.map((group) => {
    const canonicalSourceUrls = new Set(
      group.map((item) => normalizeUrl(item.applyUrl)).filter(Boolean),
    );
    return [...group].sort(
      (a, b) =>
        searchSeedAuthorityScore(b, canonicalSourceUrls) -
        searchSeedAuthorityScore(a, canonicalSourceUrls),
    )[0];
  });
}

function sameSearchVacancy(
  left: Pick<JobOpportunity, "jobNumber" | "company" | "title" | "sourceUrl" | "applyUrl">,
  right: Pick<JobResearchFailure, "jobNumber" | "company" | "title" | "sourceUrl" | "applyUrl">,
) {
  if (
    left.jobNumber !== undefined &&
    right.jobNumber !== undefined &&
    left.jobNumber === right.jobNumber &&
    normalizeJobIdentityText(left.company) ===
      normalizeJobIdentityText(right.company) &&
    normalizeJobIdentityText(left.title) === normalizeJobIdentityText(right.title)
  )
    return true;
  const leftUrls = new Set(
    [left.sourceUrl, left.applyUrl]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeUrl),
  );
  return [right.sourceUrl, right.applyUrl]
    .filter((value): value is string => Boolean(value?.trim()))
    .some((value) => leftUrls.has(normalizeUrl(value)));
}

function searchSeedAuthorityScore(
  seed: JobOpportunity,
  canonicalSourceUrls: Set<string>,
) {
  const source = normalizeUrl(seed.sourceUrl);
  const host = (() => {
    try {
      return new URL(seed.sourceUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const knownAts =
    /(?:^|\.)(?:ashbyhq\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|workable\.com)$/.test(
      host,
    );
  return (
    (canonicalSourceUrls.has(source) ? 20 : 0) +
    (knownAts ? 10 : 0) +
    (normalizeUrl(seed.applyUrl) !== source ? 4 : 0) +
    Math.min(3, Math.floor((seed.description?.length || 0) / 500))
  );
}

function matchingFailureFromOpportunity(
  opportunity: JobOpportunity,
  reason: string,
): JobResearchFailure {
  return normalizeSearchValidationFailure({
    id: createHash("sha256")
      .update(`${opportunity.id}:requirements:${reason}`)
      .digest("hex")
      .slice(0, 20),
    jobNumber: opportunity.jobNumber,
    company: opportunity.company,
    title: opportunity.title,
    location: opportunity.location,
    sourceUrl: opportunity.sourceUrl,
    applyUrl: opportunity.applyUrl,
    stage: "requirements",
    disposition: "unresolved",
    reasonCode: "matching_verification",
    reason: `Requirement matching failed for this vacancy: ${reason}`,
    capturedAt: new Date().toISOString(),
  });
}

function applicationFailureFromOpportunity(
  opportunity: JobOpportunity,
  reason: string,
): JobResearchFailure {
  return normalizeSearchValidationFailure({
    id: createHash("sha256")
      .update(`${opportunity.id}:form:${reason}`)
      .digest("hex")
      .slice(0, 20),
    jobNumber: opportunity.jobNumber,
    company: opportunity.company,
    title: opportunity.title,
    location: opportunity.location,
    sourceUrl: opportunity.sourceUrl,
    applyUrl: opportunity.applyUrl,
    stage: "form",
    disposition: "unresolved",
    reasonCode: "application_form",
    reason: `Application preparation failed for this vacancy: ${reason}`,
    capturedAt: new Date().toISOString(),
  });
}

function mergeResearchFailures(
  workspace: JobSearchWorkspace,
  ...groups: JobResearchFailure[][]
) {
  const outcomes = mergeFailures(
    workspace.rejectedOpportunities,
    workspace.searchValidationIssues,
    ...groups,
  ).map(normalizeSearchValidationFailure);
  workspace.rejectedOpportunities = outcomes.filter(
    (failure) => failure.disposition === "rejected",
  );
  workspace.searchValidationIssues = outcomes.filter(
    (failure) => failure.disposition !== "rejected",
  );
}
function validHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function tailoredCvPath(
  filesDirectory: string,
  candidateId: string,
  applicationId: string,
) {
  const safeApplicationId = applicationId.replace(/[^a-z0-9-]/gi, "_");
  return path.join(
    filesDirectory,
    candidateId,
    "tailored",
    `${safeApplicationId}.docx`,
  );
}

function tailoredCvFileName(
  workspace: JobSearchWorkspace,
  application: ApplicationDraft,
) {
  const job = workspace.opportunities.find(
    (candidate) => candidate.id === application.jobId,
  );
  const base = [
    workspace.profile.name || "Candidate",
    job?.company || "Company",
    job?.title || "Role",
    "CV",
  ]
    .join("-")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${base || "Tailored-CV"}.docx`;
}

function applicationFor(
  job: JobOpportunity,
  w: JobSearchWorkspace,
): ApplicationDraft {
  const p = w.profile;
  const cover = `Dear ${job.company} hiring team,\n\nI am applying for the ${job.title} role. My background in platform engineering, durable execution, developer tooling and production reliability maps to the role's core systems responsibilities.\n\nI would welcome the opportunity to discuss the evidence in my CV and how it applies to this team.\n\nSincerely,\n${p.name}`;
  const cvName = w.sources.find((s) => s.kind === "cv")?.name ?? "";
  const fields = [
    field("name", "Full name", "text", p.name, "profile"),
    field("email", "Email", "email", p.email, "profile"),
    field("phone", "Phone", "tel", p.phone, "profile"),
    field("current_location", "Current location", "text", p.location, "profile"),
    field("linkedin", "LinkedIn URL", "text", p.linkedin, "profile"),
    field("cv", "Resume / CV", "file", cvName, "cv"),
    field("cover", "Cover letter", "textarea", cover, "generated"),
    field(
      "authorization",
      "Work authorization / sponsorship",
      "textarea",
      p.workAuthorization,
      "profile",
    ),
    field(
      "salary",
      "Compensation expectation",
      "text",
      p.salaryExpectation,
      "profile",
    ),
    field("start", "Available start date", "text", p.startDate, "profile"),
    field("why", "Why this role?", "textarea", job.summary, "generated"),
  ];
  const missing = fields
    .filter((f) => f.required && !f.value.trim())
    .map((f) => f.label);
  return {
    id: `app-${job.id}`,
    jobId: job.id,
    status: missing.length ? "needs_input" : "ready_to_send",
    coverLetter: cover,
    coverLetterChat: [],
    formFields: fields,
    missingQuestions: missing,
    adapter: adapterFor(job.applyUrl),
    liveFormValidated: false,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeApplications(applications: ApplicationDraft[]) {
  for (const application of applications) {
    application.coverLetterChat = application.coverLetterChat ?? [];
    if (application.tailoredCv) {
      application.tailoredCv.content = application.tailoredCv.content ?? "";
      application.tailoredCv.changeSummary =
        application.tailoredCv.changeSummary ?? [];
    }
  }
}

function isCoverLetterField(field: FormField) {
  return field.id === "cover" || field.canonicalKey === "cover_letter";
}

function setApplicationCoverLetter(
  application: ApplicationDraft,
  coverLetter: string,
  source: "generated" | "user" = "generated",
) {
  application.coverLetter = coverLetter;
  for (const field of application.formFields)
    if (field.id === "cover" || field.canonicalKey === "cover_letter") {
      field.value = coverLetter;
      field.source = source;
      field.confidence = 100;
    }
}

function applyGeneratedDrafts(
  workspace: JobSearchWorkspace,
  drafts: Array<{
    applicationId: string;
    coverLetter: string;
    answers?: Array<{
      fieldId: string;
      value: string;
      evidenceBasis: string;
    }>;
  }>,
  requestedIds = workspace.applications.map((item) => item.id),
) {
  const expected = new Set(requestedIds);
  for (const draft of drafts) {
    if (!expected.has(draft.applicationId)) continue;
    const application = requireApplication(workspace, draft.applicationId);
    if (application.formFields.some(isCoverLetterField))
      setApplicationCoverLetter(application, draft.coverLetter.trim());
    else application.coverLetter = "";
    for (const answer of draft.answers ?? []) {
      const field = application.formFields.find(
        (candidate) => candidate.id === answer.fieldId,
      );
      if (
        !field ||
        field.type === "file" ||
        field.value.trim() ||
        isProtectedApplicationField(field)
      )
        continue;
      const value = answer.value.trim();
      const evidence = answer.evidenceBasis.trim();
      if (!value || !evidence) continue;
      if (field.type === "select" && field.options?.length) {
        const selected = field.options.find(
          (option) => normalizeChoice(option) === normalizeChoice(value),
        );
        if (!selected) continue;
        field.value = selected;
      } else field.value = value;
      field.source = "generated";
      field.confidence = 85;
      field.evidence = evidence;
    }
    refreshApplicationReadiness(application);
    expected.delete(draft.applicationId);
  }
  if (expected.size > 0)
    throw new Error("Codex did not return every requested cover letter");
}

function isProtectedApplicationField(field: FormField) {
  const value = `${field.canonicalKey || ""} ${field.label}`.toLowerCase();
  return /eeoc|gender|race|ethnicity|veteran|disability|criminal|salary|compensation|authori[sz]ation|sponsorship|visa|phone|email|legal name|full name/.test(
    value,
  );
}

function normalizeChoice(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function refreshApplicationReadiness(
  application: ApplicationDraft,
  touch = true,
) {
  application.missingQuestions = application.formFields
    .filter((field) => field.required && !field.value.trim())
    .map((field) => field.label);
  if (
    !application.liveFormValidated &&
    !application.missingQuestions.includes("Employer form requires manual review")
  )
    application.missingQuestions.push("Employer form requires manual review");
  application.status = application.missingQuestions.length
    ? "needs_input"
    : "ready_to_send";
  if (touch) application.updatedAt = new Date().toISOString();
}

export function applicationIsPreparedForVerification(
  application: ApplicationDraft,
) {
  if (!application.liveFormValidated || application.formFields.length === 0)
    return false;
  const schema = application.formSchema;
  if (
    !schema ||
    !schema.verifiedByAgent ||
    !schema.fingerprint.trim() ||
    schema.issues.length > 0 ||
    schema.observedQuestionCount <= 0 ||
    schema.observedQuestionCount !== schema.mappedQuestionCount ||
    schema.mappedQuestionCount !== application.formFields.length
  )
    return false;
  const ids = new Set<string>();
  const employerIds = new Set<string>();
  for (const field of application.formFields) {
    if (!field.id.trim() || !field.label.trim() || ids.has(field.id)) return false;
    const employerId = (field.externalName || "").trim();
    if (!employerId || employerIds.has(employerId)) return false;
    ids.add(field.id);
    employerIds.add(employerId);
  }
  return true;
}

function applicationVerificationBlockReason(application: ApplicationDraft) {
  if (!application.liveFormValidated)
    return "Application verification blocked: employer form was not mapped";
  if (application.formFields.length === 0)
    return "Application verification blocked: no employer fields were captured";
  return "Application verification blocked: captured form schema is incomplete or ambiguous";
}

function syncSharedAnswersFromProfile(workspace: JobSearchWorkspace) {
  const values: Record<string, string> = {
    name: workspace.profile.name,
    email: workspace.profile.email,
    phone: workspace.profile.phone,
    linkedin: workspace.profile.linkedin,
    github: workspace.profile.github,
    website: workspace.profile.website,
    current_location: workspace.profile.location,
    intended_work_location: workspace.profile.location,
    country: countryNameFromLocation(workspace.profile.location),
    work_authorization: workspace.profile.workAuthorization,
    start_date: workspace.profile.startDate,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value.trim()) workspace.sharedAnswers[key] = value.trim();
    else delete workspace.sharedAnswers[key];
  }
}

function countryNameFromLocation(location: string) {
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) || location.trim();
}

function pipelineIdentity(job: JobOpportunity) {
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    company: job.company,
    title: job.title,
    sourceUrl: job.sourceUrl,
  };
}

function progressEvent(message: string) {
  return {
    id: randomUUID(),
    message,
    createdAt: new Date().toISOString(),
  };
}

function isSearchProgressRunning(
  progress: JobSearchWorkspace["searchProgress"],
) {
  return (
    progress?.stage === "looking" ||
    progress?.stage === "verifying" ||
    progress?.stage === "filling"
  );
}

function setSearchStage(
  workspace: JobSearchWorkspace,
  stage: NonNullable<JobSearchWorkspace["searchProgress"]>["stage"],
  target: number,
  found: number,
  activity: string,
) {
  const current = workspace.searchProgress;
  const events = [...(current?.events ?? [])];
  if (activity && current?.activity !== activity) events.push(progressEvent(activity));
  workspace.searchProgress = {
    ...current,
    stage,
    target,
    found,
    error: stage === "failed" ? current?.error : undefined,
    activity,
    updatedAt: new Date().toISOString(),
    items: current?.items ?? [],
    events: events.slice(-10),
  };
}

function applyProgressUpdate(
  workspace: JobSearchWorkspace,
  update: OpportunityProgressUpdate,
) {
  if (!workspace.searchProgress) return;
  const progress = workspace.searchProgress;
  if (update.activity && update.activity !== progress.activity) {
    progress.activity = update.activity;
    progress.events = [
      ...(progress.events ?? []),
      progressEvent(update.activity),
    ].slice(-10);
  }
  if (update.item) {
    progress.items ??= [];
    let item = progress.items.find(
      (candidate) =>
        candidate.id === update.item!.id ||
        candidate.sourceUrl === update.item!.sourceUrl,
    );
    if (!item) {
      item = {
        ...update.item,
        validation: "waiting",
        match: "waiting",
        application: "waiting",
        applicationVerification: "waiting",
      } satisfies SearchPipelineItem;
      progress.items.push(item);
    } else {
      item.company = update.item.company || item.company;
      item.title = update.item.title || item.title;
      item.sourceUrl = update.item.sourceUrl || item.sourceUrl;
    }
    if (update.item.jobNumber) item.jobNumber = update.item.jobNumber;
    if (update.phase === "validation") item.validation = update.state ?? item.validation;
    if (update.phase === "match") item.match = update.state ?? item.match;
    if (update.phase === "application") item.application = update.state ?? item.application;
    if (update.phase === "application_verification")
      item.applicationVerification = update.state ?? item.applicationVerification;
    if (typeof update.fit === "number") item.fit = update.fit;
    if (update.validationDisposition)
      item.validationDisposition = update.validationDisposition;
    if (update.reason) item.reason = update.reason;
    else if (update.state === "passed") {
      item.reason = undefined;
      if (update.phase === "validation") item.validationDisposition = undefined;
    }
    upsertJobHistory(workspace, item);
  }
  progress.updatedAt = new Date().toISOString();
}

function normalizeJobHistory(workspace: JobSearchWorkspace) {
  const history: SearchPipelineItem[] = [];
  const add = (item: SearchPipelineItem) => upsertPipelineItem(history, item);
  for (const failure of [
    ...workspace.rejectedOpportunities,
    ...workspace.searchValidationIssues,
  ]) {
    const atMatch = failure.stage === "requirements";
    const atApplication = failure.stage === "form";
    add({
      id: failure.id,
      jobNumber: failure.jobNumber,
      company: failure.company,
      title: failure.title,
      sourceUrl: failure.sourceUrl,
      validation: atMatch || atApplication ? "passed" : "failed",
      match: atApplication ? "passed" : atMatch ? "failed" : "waiting",
      application: atApplication ? "failed" : "waiting",
      applicationVerification: "waiting",
      reason: failure.reason,
      validationDisposition: failure.disposition,
    });
  }
  for (const job of workspace.searchReadyOpportunities) {
    add({
      ...pipelineIdentity(job),
      validation: "passed",
      match: "waiting",
      application: "waiting",
      applicationVerification: "waiting",
    });
  }
  // Preserve explicit pipeline states first, then let permanent application-list
  // membership override duplicated endpoints.
  for (const item of workspace.jobHistory ?? []) add(item);
  for (const item of workspace.searchProgress?.items ?? []) add(item);
  for (const job of workspace.opportunities) {
    const application = workspace.applications.find(
      (candidate) => candidate.jobId === job.id,
    );
    const prior = history.find(
      (item) =>
        item.id === job.id ||
        (job.jobNumber && item.jobNumber === job.jobNumber),
    );
    add({
      ...pipelineIdentity(job),
      validation: "passed",
      match: application?.addedBy === "user" ? "selected" : "passed",
      application: application
        ? application.addedBy === "agent"
          ? "passed"
          : application.addedBy === "user"
            ? "selected"
            : "failed"
        : prior?.application === "failed"
          ? "failed"
          : "bench",
      applicationVerification: application
        ? application.addedBy === "agent"
          ? "passed"
          : application.addedBy === "user"
            ? "waiting"
            : "failed"
        : prior?.applicationVerification === "failed"
          ? "failed"
          : "waiting",
      applicationReady: application?.status === "ready_to_send",
      fit: job.fit,
      ...(application?.addedBy === "user"
        ? { reason: "Added manually to the candidate's application list" }
        : {}),
    });
  }
  return history.sort(
    (a, b) => (b.jobNumber ?? -1) - (a.jobNumber ?? -1),
  );
}

export function finalizePipelineHistory(workspace: JobSearchWorkspace) {
  const applicationsByJobId = new Map(
    workspace.applications.map((application) => [application.jobId, application]),
  );
  const finalized = normalizeJobHistory(workspace).map((item) => {
    const application = applicationsByJobId.get(item.id);
    const next = { ...item };
    if (next.validation === "running") next.validation = "bench";
    if (next.match === "running") next.match = "bench";
    if (next.application === "running") next.application = "failed";
    if (next.applicationVerification === "running")
      next.applicationVerification = "failed";
    if (
      application &&
      !application.addedBy &&
      (next.application === "failed" ||
        next.applicationVerification === "failed") &&
      !next.reason
    )
      next.reason = "Application preparation did not pass verification";
    return next;
  });
  workspace.jobHistory = finalized;
  if (workspace.searchProgress)
    workspace.searchProgress.items = structuredClone(finalized);
}

function upsertJobHistory(
  workspace: JobSearchWorkspace,
  incoming: SearchPipelineItem,
) {
  workspace.jobHistory ??= [];
  upsertPipelineItem(workspace.jobHistory, incoming);
}

function upsertPipelineItem(
  items: SearchPipelineItem[],
  incoming: SearchPipelineItem,
) {
  const existing = items.find(
    (item) =>
      item.id === incoming.id ||
      (incoming.jobNumber && item.jobNumber === incoming.jobNumber),
  );
  if (existing) Object.assign(existing, incoming);
  else items.push(structuredClone(incoming));
}

function field(
  id: string,
  label: string,
  type: ApplicationDraft["formFields"][number]["type"],
  value: string,
  source: ApplicationDraft["formFields"][number]["source"],
) {
  return {
    id,
    label,
    type,
    value,
    required: true,
    source,
    confidence: source === "generated" ? 75 : source === "user" ? 0 : 100,
  };
}
function adapterFor(url: string): ApplicationDraft["adapter"] {
  if (url.includes("greenhouse")) return "greenhouse";
  if (url.includes("lever.co")) return "lever";
  if (url.includes("ashbyhq")) return "ashby";
  if (url.includes("openai.com/careers")) return "openai-careers";
  return "generic";
}
