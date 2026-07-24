import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readCandidateSourceChunks } from "../../01-evidence-ingestion/02-chunk-reader/index.js";
import { synthesizeCandidateEvidence } from "../../01-evidence-ingestion/03-synthesis/index.js";
import { verifyAndPersistEvidence } from "../../01-evidence-ingestion/04-verification/index.js";
import { command as SOURCE_READER_COMMAND } from "../../01-evidence-ingestion/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import type {
  CandidateAnalysisResult,
  ChunkReadingResult,
} from "../../01-evidence-ingestion/types.js";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import { buildApplicationContext } from "../../04-application-preparation/01-context/index.js";
import { draftApplicationContent } from "../../04-application-preparation/02-draft/index.js";
import { verifyApplicationDrafts } from "../../04-application-preparation/03-verification/index.js";
import { repairApplicationDrafts } from "../../04-application-preparation/04-repair/index.js";
import {
  refineApplicationAnswer,
  refineCoverLetter,
} from "../../04-application-preparation/05-refinement/index.js";
import type {
  ApplicationContentDraft,
  ApplicationDraftVerification,
} from "../../04-application-preparation/types.js";
import type { JobSearchService } from "./service.js";
import {
  createRolegainDependencies,
  type RolegainDependencies,
} from "./composition.js";
import {
  MOCK_CV_TEXT,
  mockAnalysis,
  mockThreeChunkReading,
  mockWorkspaceWithCv,
} from "../../01-evidence-ingestion/inspection/fixtures.js";

export type LiveStage =
  | "evidence-reader"
  | "evidence-synthesis"
  | "evidence-verification"
  | "evidence"
  | "opportunity-research"
  | "discovery"
  | "matching"
  | "inspection"
  | "application-context"
  | "application-draft"
  | "application-verification"
  | "application-repair"
  | "application-refinement"
  | "drafting"
  | "full";

export interface LiveArtifact {
  stage: LiveStage;
  createdAt: string;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  runtime?: unknown;
  codexRuns?: string[];
  reading?: ChunkReadingResult;
  analysis?: CandidateAnalysisResult;
  evidenceRun?: unknown;
  research?: {
    opportunities: JobOpportunity[];
    applications: ApplicationDraft[];
    failures?: unknown[];
    seenUrls?: string[];
  };
  opportunities?: JobOpportunity[];
  inspection?: { applications: ApplicationDraft[]; failures: unknown[] };
  contexts?: Array<Awaited<ReturnType<typeof buildApplicationContext>>>;
  drafts?: ApplicationContentDraft[];
  verifications?: ApplicationDraftVerification[];
  refinementRequest?: {
    applicationId: string;
    fieldId?: string;
    message: string;
  };
  refinement?: unknown;
  filledApplications?: ApplicationDraft[];
  report?: Record<string, unknown>;
}

const STAGE_DIRECTORIES: Record<LiveStage, string> = {
  "evidence-reader": "01a-evidence-reader",
  "evidence-synthesis": "01b-evidence-synthesis",
  "evidence-verification": "01c-evidence-verification",
  evidence: "01-evidence",
  "opportunity-research": "03-match",
  discovery: "02-search",
  matching: "03-match/01-requirement-matching",
  inspection: "03-match/02-application-inspection",
  "application-context": "04-application-preparation/01-context",
  "application-draft": "04-application-preparation/02-draft",
  "application-verification": "04-application-preparation/03-verification",
  "application-repair": "04-application-preparation/04-repair",
  "application-refinement": "04-application-preparation/05-refinement",
  drafting: "04-application-preparation",
  full: "full-user-flow",
};

const LIVE_CV = `${MOCK_CV_TEXT}

EXPERIENCE
Platform Engineer, Northstar Systems, 2021-present
- Built a multi-tenant TypeScript workflow service processing 600,000 jobs monthly.
- Reduced failed deployments by 35% through automated validation and rollback controls.
- Operated PostgreSQL and Docker services used by distributed engineering teams.

Software Engineer, River Labs, 2018-2021
- Developed Node.js APIs and React administration tools.

SKILLS
TypeScript, Node.js, React, PostgreSQL, Docker, distributed systems

LANGUAGES
English - professional working proficiency`;

/** Run one manual live stage. Mock means mock input; Codex itself is always real. */
export async function runLiveStage(input: {
  stage: LiveStage;
  artifactRoot: string;
  source?: string;
  target?: number;
}) {
  const projectRoot = process.cwd();
  const artifactRoot = path.resolve(input.artifactRoot);
  const directory = path.join(artifactRoot, STAGE_DIRECTORIES[input.stage]);
  await mkdir(directory, { recursive: true });
  const resolved = await resolveInput(
    input.stage,
    artifactRoot,
    input.source || "mock",
  );
  await writeJson(path.join(directory, "input.json"), resolved);
  const runsBefore = await runtimeRuns(projectRoot);
  const dataRoot =
    resolved.dataRoot ||
    path.join(artifactRoot, input.stage === "full" ? "full-data" : "data");
  const dependencies = await createRolegainDependencies({
    rootDir: projectRoot,
    dataRoot,
  });
  const codex = dependencies.codex;
  const runtime = await codex.start();

  try {
    let artifact: LiveArtifact;
    if (input.stage === "evidence-reader") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = resolved.dataRoot || path.join(artifactRoot, "data");
      const reading = await readCandidateSourceChunks({
        codex,
        cwd: projectRoot,
        workspace,
        model: liveEvidenceModel(),
      });
      if (!reading.totalChunks || !reading.sourceNotes.length)
        throw new Error("Live reader returned no chunk evidence");
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.reading = reading;
      artifact.report = {
        chunks: reading.totalChunks,
        sources: reading.sourceNotes.length,
        claims: reading.sourceNotes.reduce(
          (total, source) =>
            total + source.chunks.reduce((count, chunk) => count + chunk.claims.length, 0),
          0,
        ),
      };
    } else if (input.stage === "evidence-synthesis") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = resolved.dataRoot || path.join(artifactRoot, "data");
      if (!resolved.reading) throw new Error("Live synthesis input has no chunk reading");
      const analysis = await synthesizeCandidateEvidence({
        codex,
        cwd: projectRoot,
        workspace,
        model: liveEvidenceModel(),
        reading: resolved.reading,
      });
      if (!analysis.sourceInsights.length)
        throw new Error("Live synthesis returned no source insights");
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.reading = resolved.reading;
      artifact.analysis = analysis;
      artifact.report = {
        sourceInsights: analysis.sourceInsights.length,
        roleFamilies: analysis.roleFamilies?.length || 0,
        unknowns: analysis.unknowns?.length || 0,
      };
    } else if (input.stage === "evidence-verification") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = resolved.dataRoot || path.join(artifactRoot, "data");
      if (!resolved.analysis) throw new Error("Live verification input has no synthesis output");
      const evidenceRun = await verifyAndPersistEvidence({
        dataRoot,
        workspace,
        analysis: resolved.analysis,
        sourceIdsToAnalyze: new Set(workspace.sources.map((source) => source.id)),
      });
      if (!evidenceRun.manifest.readiness.readyForSearch)
        throw new Error(
          `Verified evidence is not search-ready: ${evidenceRun.manifest.readiness.blockers.join("; ")}`,
        );
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.analysis = resolved.analysis;
      artifact.evidenceRun = evidenceRun;
      artifact.report = evidenceRun.manifest.readiness.counts;
    } else if (input.stage === "evidence") {
      artifact = await runLiveEvidence({
        dependencies,
        runtime,
      });
    } else if (input.stage === "opportunity-research") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const result = await dependencies.researcher.run(workspace, {
        limit: input.target || liveDiscoveryTarget(),
      });
      if (result.opportunities.length)
        assertValidatedOpportunities(result.opportunities);
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.research = {
        opportunities: result.opportunities,
        applications: result.applications,
        failures: result.failures,
        seenUrls: result.seenUrls,
      };
      artifact.opportunities = result.opportunities;
      artifact.inspection = {
        applications: result.applications,
        failures: result.failures,
      };
      artifact.report = {
        matched: result.opportunities.length,
        mappedForms: result.applications.filter(
          (application) => application.liveFormValidated,
        ).length,
        failures: result.failures.length,
      };
    } else if (input.stage === "discovery") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const research = await dependencies.researcher.research(workspace, {
        limit: input.target || liveDiscoveryTarget(),
      });
      assertValidatedOpportunities(research.opportunities);
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.research = research;
      artifact.opportunities = research.opportunities;
      artifact.report = searchReport(research.opportunities, research.failures || []);
    } else if (input.stage === "matching") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const candidates = resolved.opportunities || resolved.research?.opportunities || [];
      if (!candidates.length) throw new Error("Matching input has no validated jobs");
      const result = await dependencies.researcher.assess(workspace, candidates);
      const opportunities = Array.isArray(result) ? result : result.opportunities;
      if (!opportunities.length) throw new Error("No job passed live requirement matching");
      if (opportunities.some((job) => job.requirementMatches.length === 0))
        throw new Error("A matched job has no requirement evidence matrix");
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.opportunities = opportunities;
      artifact.report = {
        inputJobs: candidates.length,
        matchedJobs: opportunities.length,
        fits: opportunities.map((job) => ({
          company: job.company,
          title: job.title,
          fit: job.fit,
        })),
      };
    } else if (input.stage === "inspection") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const opportunities = resolved.opportunities || [];
      if (!opportunities.length) throw new Error("Inspection input has no matched jobs");
      const inspection = await dependencies.researcher.inspectApplications(
        workspace,
        opportunities,
      );
      const mapped = inspection.applications.filter(
        (application) => application.liveFormValidated,
      );
      if (!mapped.length)
        throw new Error("No employer application form could be mapped live");
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.opportunities = opportunities;
      artifact.inspection = inspection;
      artifact.report = {
        inspected: inspection.applications.length,
        mapped: mapped.length,
        failures: inspection.failures.length,
      };
    } else if (input.stage === "application-context") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const opportunities = resolved.opportunities || workspace.opportunities;
      const applications = resolved.inspection?.applications || workspace.applications;
      if (!applications.length)
        throw new Error("Application context input has no mapped applications");
      workspace.opportunities = opportunities;
      workspace.applications = applications;
      const contexts = await Promise.all(
        applications.map((application) =>
          buildApplicationContext(workspace, application, dataRoot),
        ),
      );
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.opportunities = opportunities;
      artifact.inspection = { applications, failures: [] };
      artifact.contexts = contexts;
      artifact.report = { contexts: contexts.length };
    } else if (input.stage === "application-draft") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      if (!resolved.contexts?.length)
        throw new Error("Application draft input has no grounded contexts");
      const drafts = await draftApplicationContent({
        codex,
        cwd: projectRoot,
        contexts: resolved.contexts,
      });
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.contexts = resolved.contexts;
      artifact.drafts = drafts;
      artifact.report = { drafted: drafts.length };
    } else if (input.stage === "application-verification") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      if (!resolved.contexts?.length || !resolved.drafts?.length)
        throw new Error("Application verification needs contexts and drafts");
      const verifications = await verifyApplicationDrafts({
        codex,
        cwd: projectRoot,
        contexts: resolved.contexts,
        drafts: resolved.drafts,
      });
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.contexts = resolved.contexts;
      artifact.drafts = resolved.drafts;
      artifact.verifications = verifications;
      artifact.report = {
        verified: verifications.length,
        needsRepair: verifications.filter((item) => item.verdict === "needs_repair").length,
      };
    } else if (input.stage === "application-repair") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const failures = (resolved.verifications || []).filter(
        (item) => item.verdict === "needs_repair",
      );
      if (!resolved.contexts?.length || !resolved.drafts?.length || !failures.length)
        throw new Error("Application repair needs contexts, drafts, and failed verifications");
      const drafts = await repairApplicationDrafts({
        codex,
        cwd: projectRoot,
        contexts: resolved.contexts,
        drafts: resolved.drafts,
        failures,
      });
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.contexts = resolved.contexts;
      artifact.drafts = drafts;
      artifact.verifications = resolved.verifications;
      artifact.report = { repaired: failures.length };
    } else if (input.stage === "application-refinement") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const request = resolved.refinementRequest;
      if (!request)
        throw new Error("Application refinement needs refinementRequest");
      const application = workspace.applications.find(
        (item) => item.id === request.applicationId,
      );
      if (!application)
        throw new Error(`Unknown application ${request.applicationId}`);
      const refinement = request.fieldId
        ? await refineApplicationAnswer({
            codex,
            cwd: projectRoot,
            dataRoot,
            workspace,
            application,
            field:
              application.formFields.find((field) => field.id === request.fieldId) ??
              (() => {
                throw new Error(`Unknown application field ${request.fieldId}`);
              })(),
            message: request.message,
          })
        : await refineCoverLetter({
            codex,
            cwd: projectRoot,
            dataRoot,
            workspace,
            application,
            message: request.message,
          });
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.refinementRequest = request;
      artifact.refinement = refinement;
      artifact.report = { refined: 1, target: request.fieldId ? "answer" : "cover-letter" };
    } else if (input.stage === "drafting") {
      const workspace = requiredWorkspace(resolved);
      const dataRoot = requiredDataRoot(resolved);
      const opportunities = resolved.opportunities || [];
      const applications = resolved.inspection?.applications || [];
      const eligible = applications.filter(
        (application) =>
          application.liveFormValidated && application.formFields.length > 0,
      );
      if (!eligible.length) throw new Error("Drafting input has no mapped applications");
      workspace.opportunities = opportunities;
      workspace.applications = applications;
      const drafts = await dependencies.writer.draft(
        workspace,
        eligible.map((application) => application.id),
      );
      if (drafts.length !== eligible.length)
        throw new Error(`Expected ${eligible.length} live drafts, received ${drafts.length}`);
      const filledApplications = applyDrafts(eligible, drafts as DraftOutput[]);
      artifact = baseArtifact(input.stage, dataRoot, workspace, runtime);
      artifact.opportunities = opportunities;
      artifact.inspection = resolved.inspection;
      artifact.drafts = drafts;
      artifact.filledApplications = filledApplications;
      artifact.report = {
        requested: eligible.length,
        drafted: drafts.length,
        answerCounts: filledApplications.map((application) =>
          application.formFields.filter((field) => field.value.trim()).length,
        ),
      };
    } else {
      artifact = await runFullUserFlow({
        dependencies,
        runtime,
        target: input.target || liveApplicationTarget(),
      });
    }

    artifact.codexRuns = difference(await runtimeRuns(projectRoot), runsBefore);
    const outputFile = path.join(directory, "output.json");
    await writeJson(outputFile, artifact);
    return { artifact, outputFile };
  } catch (error) {
    await writeJson(path.join(directory, "failure.json"), {
      stage: input.stage,
      createdAt: new Date().toISOString(),
      dataRoot: resolved.dataRoot,
      input: input.source || "mock",
      runtime,
      error: error instanceof Error ? error.message : String(error),
      codexRuns: difference(await runtimeRuns(projectRoot), runsBefore),
    });
    throw error;
  } finally {
    await dependencies.close();
  }
}

async function runLiveEvidence(input: {
  dependencies: RolegainDependencies;
  runtime: unknown;
}): Promise<LiveArtifact> {
  const service = input.dependencies.jobSearch;
  await service.addSource({ kind: "cv", name: "mira-live-cv.txt", content: LIVE_CV });
  let workspace = await service.analyzeCandidate();
  if (workspace.intelligence.status !== "ready")
    throw new Error(`Live evidence ingestion failed: ${workspace.intelligence.error || "unknown error"}`);
  if (!workspace.intelligence.evidenceRun?.readyForSearch)
    throw new Error(
      `Live evidence is not search-ready: ${workspace.intelligence.evidenceRun?.blockers.join("; ") || "no evidence run"}`,
    );
  await prepareIntake(service);
  workspace = await service.finishIntake();
  const evidenceRun = workspace.intelligence.evidenceRun!;
  return {
    ...baseArtifact("evidence", input.dependencies.dataRoot, workspace, input.runtime),
    report: {
      supportedClaims: evidenceRun.counts.supportedClaims,
      capabilities: evidenceRun.counts.capabilities,
      roleFamilies: evidenceRun.counts.roleFamilies,
      sourceInsights: workspace.sources.reduce(
        (total, source) => total + source.insights.length,
        0,
      ),
    },
  };
}

async function runFullUserFlow(input: {
  dependencies: RolegainDependencies;
  runtime: unknown;
  target: number;
}): Promise<LiveArtifact> {
  const service = input.dependencies.jobSearch;
  await service.addSource({ kind: "cv", name: "mira-live-cv.txt", content: LIVE_CV });
  let workspace = await service.analyzeCandidate();
  if (!workspace.intelligence.evidenceRun?.readyForSearch)
    throw new Error("Full live flow stopped because evidence was not search-ready");
  await prepareIntake(service);
  await service.finishIntake();
  await service.updateSearchConfig({
    discoveryTarget: Math.max(20, input.target * 4),
    applicationTarget: input.target,
  });
  workspace = await service.prepareApplications(undefined, input.target);
  const filled = workspace.applications.filter(
    (application) => application.addedBy === "agent",
  );
  if (filled.length < input.target)
    throw new Error(
      `Full live flow prepared ${filled.length} of ${input.target} requested applications: ${workspace.searchProgress?.error || "bounded live search did not return enough eligible, accessible forms"}`,
    );
  const filledJobs = workspace.opportunities.filter((job) =>
    filled.some((application) => application.jobId === job.id),
  );
  assertValidatedOpportunities(filledJobs);
  return {
    ...baseArtifact("full", input.dependencies.dataRoot, workspace, input.runtime),
    opportunities: filledJobs,
    filledApplications: filled,
    report: {
      target: input.target,
      prepared: filled.length,
      liveValidatedJobs: filledJobs.length,
      readyToSend: filled.filter((application) => application.status === "ready_to_send").length,
      needsInput: filled.filter((application) => application.status === "needs_input").length,
      rejectedJobs: workspace.rejectedOpportunities.length,
      unresolvedJobs: workspace.searchValidationIssues.length,
    },
  };
}

async function prepareIntake(service: JobSearchService) {
  await service.updateProfile({
    name: "Mira Example",
    email: "mira@example.test",
    location: "Bratislava, Slovakia",
  });
  const answers: Record<string, string> = {
    salary: "",
    locations: "Remote",
    employment: "Full-time",
    start: "Immediately",
    languages: "English",
  };
  const workspace = await service.get();
  for (const question of workspace.questions)
    if (question.id in answers) await service.answer(question.id, answers[question.id]);
}

async function resolveInput(
  stage: LiveStage,
  artifactRoot: string,
  source: string,
): Promise<Partial<LiveArtifact>> {
  if (source !== "mock" && source !== "previous") {
    const parsed = JSON.parse(
      await readFile(path.resolve(source), "utf8"),
    ) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "artifactKind" in parsed &&
      "data" in parsed
    )
      return (parsed as { data: LiveArtifact }).data;
    return parsed as LiveArtifact;
  }
  if (source === "previous") {
    const previous = previousStage(stage);
    if (!previous) throw new Error(`${stage} has no previous live stage`);
    return JSON.parse(
      await readFile(
        path.join(artifactRoot, STAGE_DIRECTORIES[previous], "output.json"),
        "utf8",
      ),
    ) as LiveArtifact;
  }
  if (stage === "evidence-reader")
    return {
      workspace: mockWorkspaceWithCv(),
      dataRoot: path.join(artifactRoot, "data"),
    };
  if (stage === "evidence-synthesis") {
    const workspace = mockWorkspaceWithCv();
    return {
      workspace,
      dataRoot: path.join(artifactRoot, "data"),
      reading: mockThreeChunkReading(workspace),
    };
  }
  if (stage === "evidence-verification") {
    const workspace = mockWorkspaceWithCv();
    return {
      workspace,
      dataRoot: path.join(artifactRoot, "data"),
      analysis: mockAnalysis(workspace),
    };
  }
  if (stage === "evidence" || stage === "full")
    return { dataRoot: path.join(artifactRoot, stage === "full" ? "full-data" : "data") };
  if (stage === "opportunity-research" || stage === "discovery")
    return mockReadyEvidence(artifactRoot);
  if (stage === "matching") {
    const prepared = await mockReadyEvidence(artifactRoot);
    return { ...prepared, opportunities: [mockOpportunity()] };
  }
  if (
    stage === "application-context" ||
    stage === "application-draft" ||
    stage === "application-verification" ||
    stage === "application-repair" ||
    stage === "application-refinement"
  ) {
    const prepared = await mockReadyEvidence(artifactRoot);
    const opportunity = mockOpportunity();
    const application = mockApplication(opportunity);
    prepared.workspace.opportunities = [opportunity];
    prepared.workspace.applications = [application];
    const contexts = [
      await buildApplicationContext(
        prepared.workspace,
        application,
        prepared.dataRoot,
      ),
    ];
    const drafts: ApplicationContentDraft[] = [
      {
        applicationId: application.id,
        coverLetter: "",
        answers: [
          {
            fieldId: "experience",
            value: "I designed durable TypeScript workflow services and idempotent recovery checkpoints.",
            evidenceBasis: "CV claims about TypeScript workflow recovery and idempotent checkpoints.",
          },
        ],
      },
    ];
    const base = {
      ...prepared,
      opportunities: [opportunity],
      inspection: { applications: [application], failures: [] },
      contexts,
    };
    if (stage === "application-context" || stage === "application-draft")
      return base;
    if (stage === "application-verification") return { ...base, drafts };
    if (stage === "application-repair")
      return {
        ...base,
        drafts,
        verifications: [
          {
            applicationId: application.id,
            verdict: "needs_repair" as const,
            findings: ["Answer needs a more precise evidence basis."],
            repairInstructions: ["Tie the answer directly to the supplied CV claims."],
          },
        ],
      };
    return {
      ...base,
      refinementRequest: {
        applicationId: application.id,
        fieldId: "experience",
        message: "Make the answer more concise.",
      },
    };
  }
  if (stage === "drafting") {
    const prepared = await mockReadyEvidence(artifactRoot);
    const opportunity = mockOpportunity();
    return {
      ...prepared,
      opportunities: [opportunity],
      inspection: { applications: [mockApplication(opportunity)], failures: [] },
    };
  }
  throw new Error(
    "Live inspection needs a real job. Use --input previous or pass a discovery/matching artifact path.",
  );
}

async function mockReadyEvidence(artifactRoot: string) {
  const workspace = mockWorkspaceWithCv();
  workspace.profile.workplace = "Remote";
  workspace.profile.employmentTypes = "Full-time";
  workspace.profile.languages = ["English"];
  const dataRoot = path.join(artifactRoot, "mock-evidence-data");
  await verifyAndPersistEvidence({
    dataRoot,
    workspace,
    analysis: mockAnalysis(workspace),
    sourceIdsToAnalyze: new Set(workspace.sources.map((source) => source.id)),
  });
  workspace.phase = "search";
  return { workspace, dataRoot };
}

function previousStage(stage: LiveStage): LiveStage | undefined {
  const previous: Partial<Record<LiveStage, LiveStage>> = {
    "evidence-synthesis": "evidence-reader",
    "evidence-verification": "evidence-synthesis",
    "opportunity-research": "evidence",
    discovery: "evidence",
    matching: "discovery",
    inspection: "matching",
    "application-context": "inspection",
    "application-draft": "application-context",
    "application-verification": "application-draft",
    "application-repair": "application-verification",
    "application-refinement": "drafting",
    drafting: "inspection",
  };
  return previous[stage];
}

function mockOpportunity(): JobOpportunity {
  return {
    id: "mock-live-job",
    evidenceRunId: "mock-evidence-run",
    company: "Example Systems",
    title: "Senior Platform Engineer",
    location: "Remote Europe",
    workplace: "Remote",
    compensation: "Not disclosed",
    sourceUrl: "https://example.com/jobs/platform-engineer",
    applyUrl: "https://example.com/jobs/platform-engineer/apply",
    capturedAt: new Date().toISOString(),
    fit: 0,
    summary: "Build reliable developer workflow platforms.",
    description:
      "Design and operate TypeScript and Node.js workflow services. Build idempotent recovery, PostgreSQL persistence, Docker deployment, monitoring, and developer tooling.",
    requirements: [
      "Production TypeScript and Node.js experience",
      "Distributed workflow reliability experience",
      "PostgreSQL and Docker experience",
    ],
    requirementMatches: [],
    strengths: [],
    gaps: [],
    lastValidatedAt: new Date().toISOString(),
    validation: {
      status: "live",
      sourceConfidence: 1,
      retrievedAt: new Date().toISOString(),
      descriptionFingerprint: "mock-live-job-description",
      responsibilitiesText: "Design and operate workflow services.",
      qualificationsText: "TypeScript, Node.js, PostgreSQL, Docker.",
      riskSignals: [],
    },
  };
}

function mockApplication(job: JobOpportunity): ApplicationDraft {
  return {
    id: "mock-live-application",
    jobId: job.id,
    status: "needs_input",
    coverLetter: "",
    coverLetterChat: [],
    formFields: [
      {
        id: "experience",
        externalName: "experience",
        label: "Describe your relevant experience",
        type: "textarea",
        value: "",
        required: true,
        source: "generated",
        confidence: 0,
      },
    ],
    missingQuestions: [],
    adapter: "generic",
    liveFormValidated: true,
    formSchema: {
      observedQuestionCount: 1,
      mappedQuestionCount: 1,
      fingerprint: "mock-form",
      issues: [],
      verifiedByAgent: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

function applyDrafts(applications: ApplicationDraft[], drafts: DraftOutput[]) {
  const byId = new Map(drafts.map((draft) => [draft.applicationId, draft]));
  return applications.map((application) => {
    const draft = byId.get(application.id);
    const answers = new Map((draft?.answers || []).map((answer) => [answer.fieldId, answer]));
    return {
      ...application,
      addedBy: "agent" as const,
      coverLetter: draft?.coverLetter || "",
      formFields: application.formFields.map((field) => {
        const answer = answers.get(field.id);
        return answer
          ? { ...field, value: answer.value, evidence: answer.evidenceBasis }
          : field;
      }),
    };
  });
}

function assertValidatedOpportunities(opportunities: JobOpportunity[]) {
  if (!opportunities.length) throw new Error("Live search returned no validated jobs");
  for (const job of opportunities) {
    if (job.validation?.status !== "live")
      throw new Error(`${job.company} — ${job.title} is not verified live`);
    if (!job.lastValidatedAt)
      throw new Error(`${job.company} — ${job.title} has no validation timestamp`);
    for (const url of [job.sourceUrl, job.applyUrl])
      if (!/^https?:\/\//.test(url))
        throw new Error(`${job.company} — ${job.title} has an invalid URL`);
  }
}

function searchReport(opportunities: JobOpportunity[], failures: unknown[]) {
  return {
    validated: opportunities.length,
    failures: failures.length,
    jobs: opportunities.map((job) => ({
      company: job.company,
      title: job.title,
      location: job.location,
      workplace: job.workplace,
      status: job.validation?.status,
      sourceUrl: job.sourceUrl,
      applyUrl: job.applyUrl,
    })),
  };
}

function baseArtifact(
  stage: LiveStage,
  dataRoot: string,
  workspace: JobSearchWorkspace,
  runtime: unknown,
): LiveArtifact {
  return { stage, createdAt: new Date().toISOString(), dataRoot, workspace, runtime };
}

function requiredWorkspace(input: Partial<LiveArtifact>) {
  if (!input.workspace) throw new Error("Live stage input has no workspace");
  return input.workspace;
}

function requiredDataRoot(input: Partial<LiveArtifact>) {
  if (!input.dataRoot) throw new Error("Live stage input has no dataRoot");
  return input.dataRoot;
}

async function runtimeRuns(projectRoot: string) {
  return readdir(path.join(projectRoot, ".agent-runtime", "runs")).catch(() => []);
}

function difference(after: string[], before: string[]) {
  const existing = new Set(before);
  return after.filter((item) => !existing.has(item)).sort();
}

function liveDiscoveryTarget() {
  return Math.max(1, Number(process.env.LIVE_TEST_DISCOVERY_TARGET || 10));
}

function liveApplicationTarget() {
  return Math.max(1, Number(process.env.LIVE_TEST_APPLICATION_TARGET || 5));
}

function liveEvidenceModel() {
  return (
    process.env[SOURCE_READER_COMMAND.modelEnvironment] ||
    SOURCE_READER_COMMAND.defaultModel
  );
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface DraftOutput {
  applicationId: string;
  coverLetter: string;
  answers?: Array<{ fieldId: string; value: string; evidenceBasis: string }>;
}
