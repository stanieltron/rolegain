import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireEvidence } from "../01-evidence-acquisition/flow.js";
import {
  chunkSourceWithLocators,
  readCandidateSourceChunks,
} from "../02-chunk-reader/index.js";
import { synthesizeCandidateEvidence } from "../03-synthesis/index.js";
import { verifyAndPersistEvidence } from "../04-verification/index.js";
import {
  loadPhase2EvidenceContext,
  phase2DiscoveryPacket,
} from "../../search-match-shared/evidence-context.js";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type {
  CandidateAnalysisResult,
  ChunkReadingResult,
} from "../types.js";
import {
  MOCK_CV_TEXT,
  mockAnalysis,
  mockChunkNotes,
  mockCoverage,
  mockSynthesis,
  mockThreeChunkReading,
  mockWorkspace,
  mockWorkspaceWithCv,
} from "./fixtures.js";
import { mockCodex, type RecordedModelCall } from "./mock-codex.js";

export type InspectionStage =
  | "acquisition"
  | "reader"
  | "synthesis"
  | "verification"
  | "search-handoff";

export interface StageArtifact {
  stage: InspectionStage;
  createdAt: string;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  reading?: ChunkReadingResult;
  analysis?: CandidateAnalysisResult;
  evidenceRun?: unknown;
  searchInput?: unknown;
}

export interface RunStageOptions {
  artifactRoot: string;
  /** `mock`, `previous`, or a JSON artifact path. */
  input?: string;
}

const STAGE_DIRECTORIES: Record<InspectionStage, string> = {
  acquisition: "01-acquisition",
  reader: "02-reader",
  synthesis: "03-synthesis",
  verification: "04-verification",
  "search-handoff": "05-search-handoff",
};

/**
 * Run exactly one inspectable stage. It always writes resolved input, output,
 * and model-call files so a developer can compare the boundary line by line.
 */
export async function runInspectionStage(
  stage: InspectionStage,
  options: RunStageOptions,
): Promise<{ artifact: StageArtifact; outputFile: string }> {
  const artifactRoot = path.resolve(options.artifactRoot);
  const stageDirectory = path.join(artifactRoot, STAGE_DIRECTORIES[stage]);
  await mkdir(stageDirectory, { recursive: true });
  const input = await resolveInput(stage, artifactRoot, options.input || "mock");
  const calls: RecordedModelCall[] = [];
  await writeJson(path.join(stageDirectory, "input.json"), input);

  let artifact: StageArtifact;
  if (stage === "acquisition") {
    const workspace = input.workspace || mockWorkspace();
    const dataRoot = input.dataRoot || path.join(artifactRoot, "data");
    await acquireEvidence({
      dataRoot,
      workspace,
      source: input.cv || {
        kind: "cv",
        name: "mira-cv.txt",
        content: MOCK_CV_TEXT,
      },
      analyzeWithLlm: true,
    });
    artifact = envelope(stage, dataRoot, workspace);
  } else if (stage === "reader") {
    const workspace = requiredWorkspace(input);
    const outputs = workspace.sources.flatMap((source) =>
      chunkSourceWithLocators(source.content || "").flatMap(() => [
        mockChunkNotes(source.id),
        mockCoverage(),
      ]),
    );
    const codex = mockCodex(outputs);
    const reading = await readCandidateSourceChunks({
      codex: codex.client,
      cwd: artifactRoot,
      workspace,
      model: "mock-model",
    });
    calls.push(...codex.calls);
    artifact = {
      ...envelope(stage, input.dataRoot || path.join(artifactRoot, "data"), workspace),
      reading,
    };
  } else if (stage === "synthesis") {
    const workspace = requiredWorkspace(input);
    const reading = input.reading || mockThreeChunkReading(workspace);
    const codex = mockCodex([mockSynthesis(workspace)]);
    const analysis = await synthesizeCandidateEvidence({
      codex: codex.client,
      cwd: artifactRoot,
      workspace,
      model: "mock-model",
      reading,
    });
    calls.push(...codex.calls);
    artifact = {
      ...envelope(stage, input.dataRoot || path.join(artifactRoot, "data"), workspace),
      reading,
      analysis,
    };
  } else if (stage === "verification") {
    const workspace = requiredWorkspace(input);
    const analysis = input.analysis || mockAnalysis(workspace);
    const dataRoot = input.dataRoot || path.join(artifactRoot, "data");
    const evidenceRun = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set(workspace.sources.map((source) => source.id)),
    });
    artifact = {
      ...envelope(stage, dataRoot, workspace),
      analysis,
      evidenceRun,
    };
  } else {
    const workspace = requiredWorkspace(input);
    const dataRoot = input.dataRoot || path.join(artifactRoot, "data");
    const context = await loadPhase2EvidenceContext(dataRoot, workspace);
    if (!context) throw new Error("Verification output has no search evidence context");
    artifact = {
      ...envelope(stage, dataRoot, workspace),
      searchInput: phase2DiscoveryPacket(context),
    };
  }

  const outputFile = path.join(stageDirectory, "output.json");
  await Promise.all([
    writeJson(outputFile, artifact),
    writeJson(path.join(stageDirectory, "model-calls.json"), calls),
  ]);
  return { artifact, outputFile };
}

/** Run Flow 01 serially, then prove Flow 02 can consume its verified output. */
export async function runInspectionPipeline(artifactRoot: string) {
  const outputs: Array<{ stage: InspectionStage; outputFile: string }> = [];
  let previous: string | undefined;
  for (const stage of [
    "acquisition",
    "reader",
    "synthesis",
    "verification",
    "search-handoff",
  ] as const) {
    const result = await runInspectionStage(stage, {
      artifactRoot,
      input: previous || "mock",
    });
    outputs.push({ stage, outputFile: result.outputFile });
    previous = result.outputFile;
  }
  return outputs;
}

async function resolveInput(
  stage: InspectionStage,
  artifactRoot: string,
  input: string,
): Promise<Partial<StageArtifact> & { cv?: StageCvInput }> {
  if (input === "mock") {
    if (stage === "acquisition")
      return {
        workspace: mockWorkspace(),
        dataRoot: path.join(artifactRoot, "data"),
        cv: { kind: "cv", name: "mira-cv.txt", content: MOCK_CV_TEXT },
      };
    if (stage === "reader") return { workspace: mockWorkspaceWithCv() };
    if (stage === "synthesis") {
      const workspace = mockWorkspaceWithCv();
      return { workspace, reading: mockThreeChunkReading(workspace) };
    }
    if (stage === "verification") {
      const workspace = mockWorkspaceWithCv();
      return { workspace, analysis: mockAnalysis(workspace) };
    }
    return mockVerifiedInput(artifactRoot);
  }
  const inputFile = input === "previous"
    ? previousOutputFile(stage, artifactRoot)
    : path.resolve(input);
  const parsed = JSON.parse(await readFile(inputFile, "utf8")) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "artifactKind" in parsed &&
    "data" in parsed
  )
    return (parsed as { data: StageArtifact }).data;
  return parsed as StageArtifact;
}

async function mockVerifiedInput(artifactRoot: string) {
  const workspace = mockWorkspaceWithCv();
  const dataRoot = path.join(artifactRoot, "mock-search-data");
  await verifyAndPersistEvidence({
    dataRoot,
    workspace,
    analysis: mockAnalysis(workspace),
    sourceIdsToAnalyze: new Set(workspace.sources.map((source) => source.id)),
  });
  return { workspace, dataRoot };
}

function previousOutputFile(stage: InspectionStage, artifactRoot: string) {
  const previous: Partial<Record<InspectionStage, InspectionStage>> = {
    reader: "acquisition",
    synthesis: "reader",
    verification: "synthesis",
    "search-handoff": "verification",
  };
  const previousStage = previous[stage];
  if (!previousStage) throw new Error("Acquisition has no previous stage");
  return path.join(
    artifactRoot,
    STAGE_DIRECTORIES[previousStage],
    "output.json",
  );
}

function requiredWorkspace(input: Partial<StageArtifact>) {
  if (!input.workspace) throw new Error("Stage input must contain workspace");
  return input.workspace;
}

function envelope(
  stage: InspectionStage,
  dataRoot: string,
  workspace: JobSearchWorkspace,
): StageArtifact {
  return {
    stage,
    createdAt: new Date().toISOString(),
    dataRoot,
    workspace,
  };
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

type StageCvInput = {
  kind: "cv";
  name: string;
  content?: string;
  dataBase64?: string;
};
