import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  joinCandidateSourceChunkReadings,
  normalizeChunkNotes,
  prepareCandidateSourceChunks,
  type PreparedCandidateChunks,
} from "../../01-evidence-ingestion/v1/02-chunk-reader/index.js";
import {
  analyzeChunkOnce,
  readAndVerifyChunk,
  repairChunkOnce,
  verifyChunkCoverageOnce,
  type ChunkAnalysisResult,
  type ChunkCoverageResult,
  type ChunkReadJob,
  type ChunkReadResult,
  type ChunkRepairResult,
} from "../../01-evidence-ingestion/v1/02-chunk-reader/recovery/run-reader-with-coverage.js";
import { applyChunkRepairPatch } from "../../01-evidence-ingestion/v1/02-chunk-reader/repair/apply-chunk-repair.js";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { ChunkReadingResult } from "../../01-evidence-ingestion/types.js";
import type { EvidenceInput } from "../../01-evidence-ingestion/evidence-ingestion.js";
import { createLlmClient } from "../../llm-runtime/client.js";
import { createRolegainDependencies } from "./composition.js";
import { MOCK_CV_TEXT } from "../../01-evidence-ingestion/inspection/fixtures.js";

export type EvidencePipelineStage =
  | "acquire"
  | "prepare-chunks"
  | "chunk-analysis"
  | "chunk-coverage"
  | "chunk-repair"
  | "apply-chunk-repair"
  | "accept-chunk"
  | "read-chunk"
  | "join-chunks"
  | "ingest";

export interface EvidenceSourceControl {
  kind: EvidenceInput["kind"];
  name?: string;
  url?: string;
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  /** CLI-only convenience; resolved to dataBase64 before Stage 01 runs. */
  filePath?: string;
}

export interface EvidencePipelineArtifact {
  dataRoot?: string;
  workspace?: JobSearchWorkspace;
  cvPath?: string;
  source?: EvidenceSourceControl;
  sources?: EvidenceSourceControl[];
  cv?: {
    kind: "cv";
    name: string;
    content?: string;
    dataBase64?: string;
  };
  prepared?: PreparedCandidateChunks;
  job?: ChunkReadJob;
  recoveryFeedback?: string[];
  selectedChunk?: number;
  attempt?: number;
  analysis?: ChunkAnalysisResult;
  coverage?: ChunkCoverageResult;
  repair?: ChunkRepairResult;
  chunkResult?: ChunkReadResult;
  chunkResults?: ChunkReadResult[];
  reading?: ChunkReadingResult;
  evidence?: unknown;
  report?: Record<string, unknown>;
  codexRuns?: string[];
}

const DIRECTORIES: Record<EvidencePipelineStage, string> = {
  acquire: "01-acquisition",
  "prepare-chunks": "02a-prepare-chunks",
  "chunk-analysis": "02b-chunk-analysis",
  "chunk-coverage": "02c-chunk-coverage",
  "chunk-repair": "02d-chunk-repair",
  "apply-chunk-repair": "02e-applied-chunk-repair",
  "accept-chunk": "02f-accepted-chunks",
  "read-chunk": "02g-read-chunk",
  "join-chunks": "02h-join-chunks",
  ingest: "01-evidence-ingestion",
};

/** CLI adapter: execute one native pipeline part and persist replayable artifacts. */
export async function runEvidencePipelineStage(input: {
  stage: EvidencePipelineStage;
  artifactRoot: string;
  source: string;
  target?: number;
}) {
  const projectRoot = process.cwd();
  const artifactRoot = resolve(input.artifactRoot);
  const resolved = await resolveInput(input.stage, input.source);
  const selectedChunk =
    input.target ||
    resolved.selectedChunk ||
    (resolved.job ? resolved.job.index + 1 : 1);
  const attempt =
    input.stage === "chunk-analysis"
      ? resolved.attempt || 1
      : input.stage === "chunk-coverage"
        ? resolved.attempt || 1
        : input.stage === "chunk-repair"
          ? resolved.coverage?.attempt || 1
          : input.stage === "apply-chunk-repair"
            ? (resolved.coverage?.attempt || 1) + 1
        : undefined;
  const chunkDirectory = join(
    artifactRoot,
    DIRECTORIES[input.stage],
    `chunk-${String(selectedChunk).padStart(3, "0")}`,
  );
  const directory = isAttemptStage(input.stage)
    ? join(chunkDirectory, `attempt-${String(attempt).padStart(3, "0")}`)
    : isOneChunkStage(input.stage)
      ? chunkDirectory
      : join(artifactRoot, DIRECTORIES[input.stage]);
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "input.json"), resolved);
  const runsBefore = await runtimeRuns(projectRoot);

  try {
    let output: EvidencePipelineArtifact;
    if (input.stage === "acquire") {
      output = await runAcquireEvidence({
        projectRoot,
        artifactRoot,
        input: resolved,
        source: input.source,
      });
    } else if (input.stage === "prepare-chunks") {
      const workspace = requireWorkspace(resolved);
      const prepared = prepareCandidateSourceChunks(workspace);
      output = {
        dataRoot: resolved.dataRoot,
        workspace,
        prepared,
        report: {
          sources: new Set(prepared.jobs.map((job) => job.source.id)).size,
          chunks: prepared.jobs.length,
        },
      };
    } else if (input.stage === "join-chunks") {
      const workspace = requireWorkspace(resolved);
      const prepared = requirePrepared(resolved);
      const chunkResults =
        resolved.chunkResults ||
        resolved.reading?.chunkResults ||
        (await discoverAcceptedChunkResults(artifactRoot, prepared)) ||
        (resolved.chunkResult && prepared.jobs.length === 1
          ? [resolved.chunkResult]
          : undefined);
      if (!chunkResults)
        throw new Error("Chunk join input needs chunkResults for every prepared job");
      const reading = joinCandidateSourceChunkReadings(
        workspace,
        prepared,
        chunkResults,
      );
      output = {
        dataRoot: resolved.dataRoot,
        workspace,
        prepared,
        chunkResults,
        reading,
        report: { chunks: reading.totalChunks, sources: reading.sourceNotes.length },
      };
    } else if (input.stage === "ingest") {
      output = await runCompleteEvidenceIngestion({
        projectRoot,
        artifactRoot,
        input: resolved,
        source: input.source,
      });
    } else if (input.stage === "apply-chunk-repair") {
      const workspace = requireWorkspace(resolved);
      const job = selectJob(resolved, input.target);
      if (!resolved.analysis?.notes || !resolved.repair?.patch)
        throw new Error(
          "Apply chunk repair input needs the current analysis and a repair patch",
        );
      const notes = applyChunkRepairPatch({
        current: resolved.analysis.notes,
        patch: resolved.repair.patch,
        job,
        normalize: normalizeChunkNotes,
      });
      output = {
        dataRoot: resolved.dataRoot,
        workspace,
        job,
        selectedChunk,
        attempt,
        analysis: { notes, threadId: resolved.analysis.threadId },
        repair: resolved.repair,
        report: {
          chunk: selectedChunk,
          claimsBefore: resolved.analysis.notes.claims.length,
          claimsAfter: notes.claims.length,
          resolutions: resolved.repair.patch.resolutions,
        },
      };
    } else if (input.stage === "accept-chunk") {
      const workspace = requireWorkspace(resolved);
      const job = selectJob(resolved, input.target);
      if (!resolved.analysis?.notes || !resolved.coverage)
        throw new Error(
          "Accept chunk input needs both chunk analysis and coverage outputs",
        );
      if (!resolved.coverage.decision.passed)
        throw new Error(
          `Chunk coverage did not pass: ${resolved.coverage.decision.feedback.join("; ")}`,
        );
      const chunkResult: ChunkReadResult = {
        notes: resolved.analysis.notes,
        threadId: resolved.analysis.threadId,
        attempts: resolved.coverage.attempt,
        readerThreadIds: [resolved.analysis.threadId],
        coverageThreadIds: [resolved.coverage.threadId],
        repairThreadIds: resolved.repair ? [resolved.repair.threadId] : [],
        repairs: resolved.repair ? [resolved.repair.patch] : [],
        coverage: resolved.coverage.decision,
      };
      output = {
        dataRoot: resolved.dataRoot,
        workspace,
        job,
        selectedChunk,
        analysis: resolved.analysis,
        coverage: resolved.coverage,
        chunkResult,
        report: {
          chunk: selectedChunk,
          accepted: true,
          claims: chunkResult.notes.claims.length,
        },
      };
    } else {
      const workspace = requireWorkspace(resolved);
      const job = selectJob(resolved, input.target);
      const codex = createLlmClient(projectRoot);
      try {
        const runtime = await codex.start();
        if (!runtime.authenticated)
          throw new Error("The configured LLM transport is not authenticated");
        if (input.stage === "chunk-analysis") {
          const analysis = await analyzeChunkOnce({
            codex,
            cwd: projectRoot,
            job,
            recoveryFeedback:
              resolved.recoveryFeedback || resolved.coverage?.decision.feedback,
            normalize: normalizeChunkNotes,
          });
          output = {
            dataRoot: resolved.dataRoot,
            workspace,
            job,
            selectedChunk,
            attempt,
            analysis,
            report: { chunk: job.index + 1, claims: analysis.notes.claims.length },
          };
        } else if (input.stage === "chunk-coverage") {
          const analysis = resolved.analysis;
          if (!analysis?.notes)
            throw new Error("Chunk coverage input needs a chunk analysis output");
          const coverage = await verifyChunkCoverageOnce({
            codex,
            cwd: projectRoot,
            job,
            extraction: analysis.notes,
            attempt,
          });
          output = {
            dataRoot: resolved.dataRoot,
            workspace,
            job,
            selectedChunk,
            attempt,
            analysis,
            coverage,
            repair: resolved.repair,
            report: {
              chunk: job.index + 1,
              passed: coverage.decision.passed,
              feedback: coverage.decision.feedback,
            },
          };
        } else if (input.stage === "chunk-repair") {
          if (!resolved.analysis?.notes || !resolved.coverage)
            throw new Error(
              "Chunk repair input needs the current analysis and failed coverage",
            );
          if (resolved.coverage.decision.passed)
            throw new Error("Chunk repair is unnecessary because coverage passed");
          const repair = await repairChunkOnce({
            codex,
            cwd: projectRoot,
            job,
            extraction: resolved.analysis.notes,
            coverage: resolved.coverage.decision,
          });
          output = {
            dataRoot: resolved.dataRoot,
            workspace,
            job,
            selectedChunk,
            attempt,
            analysis: resolved.analysis,
            coverage: resolved.coverage,
            repair,
            report: {
              chunk: job.index + 1,
              additions:
                repair.patch.additions.profileEvidence.length +
                repair.patch.additions.insights.length +
                repair.patch.additions.claims.length +
                repair.patch.additions.unknowns.length +
                repair.patch.additions.prohibitedInferences.length +
                (repair.patch.additions.detailedNotes.trim() ? 1 : 0),
              removals: repair.patch.removals.length,
              resolutions: repair.patch.resolutions,
            },
          };
        } else {
          const chunkResult = await readAndVerifyChunk({
            codex,
            cwd: projectRoot,
            job,
            normalize: normalizeChunkNotes,
          });
          output = {
            dataRoot: resolved.dataRoot,
            workspace,
            job,
            selectedChunk,
            chunkResult,
            report: {
              chunk: job.index + 1,
              attempts: chunkResult.attempts || 1,
              claims: chunkResult.notes.claims.length,
            },
          };
        }
      } finally {
        await codex.close();
      }
    }

    output.codexRuns = difference(await runtimeRuns(projectRoot), runsBefore);
    await writeNaturalOutputs(input.stage, artifactRoot, directory, output);
    const outputFile = join(directory, "output.json");
    await writeJson(outputFile, output);
    return { artifact: output, outputFile };
  } catch (error) {
    await writeJson(join(directory, "failure.json"), {
      stage: input.stage,
      input: input.source,
      target: input.target,
      error: error instanceof Error ? error.message : String(error),
      codexRuns: difference(await runtimeRuns(projectRoot), runsBefore),
    });
    throw error;
  }
}

async function runCompleteEvidenceIngestion(input: {
  projectRoot: string;
  artifactRoot: string;
  input: EvidencePipelineArtifact;
  source: string;
}): Promise<EvidencePipelineArtifact> {
  const dataRoot = resolve(
    input.input.dataRoot || join(input.artifactRoot, "data"),
  );
  const sources = await resolveEvidenceInputs(input.input, input.source);
  const dependencies = await createRolegainDependencies({
    rootDir: input.projectRoot,
    dataRoot,
  });
  try {
    for (const source of sources)
      await dependencies.jobSearch.addSource(source);
    const workspace = await dependencies.jobSearch.analyzeCandidate();
    const readiness = workspace.intelligence.evidenceRun;
    if (!readiness)
      throw new Error(
        workspace.intelligence.error || "Evidence ingestion produced no canonical evidence run",
      );
    const evidence = await dependencies.jobSearch.canonicalEvidence(
      workspace.candidateId,
    );
    return {
      dataRoot,
      workspace,
      evidence,
      report: {
        inputSources: sources.length,
        readyForSearch: readiness.readyForSearch,
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        ...readiness.counts,
      },
    };
  } finally {
    await dependencies.close();
  }
}

async function runAcquireEvidence(input: {
  projectRoot: string;
  artifactRoot: string;
  input: EvidencePipelineArtifact;
  source: string;
}): Promise<EvidencePipelineArtifact> {
  const dataRoot = resolve(
    input.input.dataRoot || join(input.artifactRoot, "data"),
  );
  const sources = await resolveEvidenceInputs(input.input, input.source);
  if (sources.length !== 1)
    throw new Error("evidence.acquire-source accepts exactly one source");
  const dependencies = await createRolegainDependencies({
    rootDir: input.projectRoot,
    dataRoot,
  });
  try {
    const workspace = await dependencies.jobSearch.addSource(sources[0]);
    return {
      dataRoot,
      workspace,
      report: {
        sources: workspace.sources.length,
        extractedCharacters:
          sources[0].kind === "cv"
            ? workspace.finalCv.length
            : workspace.sources.find(
                (source) =>
                  source.kind === sources[0].kind &&
                  source.name === sources[0].name,
              )?.content?.length || 0,
      },
    };
  } finally {
    await dependencies.close();
  }
}

async function resolveInput(
  stage: EvidencePipelineStage,
  source: string,
): Promise<EvidencePipelineArtifact> {
  const file = resolve(source);
  if (source === "mock" && (stage === "acquire" || stage === "ingest"))
    return {
      source: { kind: "cv", name: "mira-cv.txt", content: MOCK_CV_TEXT },
    };
  if ((stage === "acquire" || stage === "ingest") && isHttpUrl(source))
    return { source: sourceControlFromUrl(source) };
  if (
    (stage === "acquire" || stage === "ingest") &&
    extname(file).toLowerCase() !== ".json"
  )
    return { cvPath: file };
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "artifactKind" in parsed &&
    "data" in parsed
  )
    return (parsed as { data: EvidencePipelineArtifact }).data;
  return parsed as EvidencePipelineArtifact;
}

async function resolveEvidenceInputs(
  input: EvidencePipelineArtifact,
  sourceArgument: string,
): Promise<EvidenceInput[]> {
  const controls = input.sources ??
    (input.source ? [input.source] : input.cv ? [input.cv] : undefined);
  if (controls?.length)
    return Promise.all(controls.map(resolveEvidenceSourceControl));

  const file = resolve(input.cvPath || sourceArgument);
  return [{
    kind: "cv",
    name: basename(file),
    dataBase64: (await readFile(file)).toString("base64"),
  }];
}

async function resolveEvidenceSourceControl(
  control: EvidenceSourceControl,
): Promise<EvidenceInput> {
  if (
    !["cv", "document", "github", "portfolio", "repository", "webpage"].includes(
      control.kind,
    )
  )
    throw new Error(`Unsupported evidence source kind: ${String(control.kind)}`);

  const file = control.filePath ? resolve(control.filePath) : undefined;
  const name =
    control.name?.trim() ||
    (file ? basename(file) : control.url ? new URL(control.url).hostname : "Source");
  const dataBase64 = file
    ? (await readFile(file)).toString("base64")
    : control.dataBase64;
  if (control.kind === "cv") {
    if (control.url)
      throw new Error("A CV source must use filePath, dataBase64, or content, not url");
    return {
      kind: "cv",
      name,
      content: control.content,
      dataBase64,
      mimeType: control.mimeType,
    };
  }
  return {
    kind: control.kind,
    name,
    url: control.url,
    content: control.content,
    dataBase64,
    mimeType: control.mimeType,
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sourceControlFromUrl(value: string): EvidenceSourceControl {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  const github = url.hostname.toLowerCase() === "github.com";
  return {
    kind: github ? (parts.length > 1 ? "repository" : "github") : "webpage",
    name: github ? parts.slice(0, 2).join("/") || url.hostname : url.hostname,
    url: url.href,
  };
}

function requireWorkspace(input: EvidencePipelineArtifact) {
  if (!input.workspace) throw new Error("Evidence stage input has no workspace");
  return input.workspace;
}

function requirePrepared(input: EvidencePipelineArtifact) {
  const prepared = input.prepared || input.reading?.prepared;
  if (!prepared?.jobs.length)
    throw new Error("Evidence stage input has no prepared chunks");
  return prepared;
}

function selectJob(input: EvidencePipelineArtifact, target?: number) {
  if (input.job) return input.job;
  const prepared = requirePrepared(input);
  const index = target === undefined ? 0 : target - 1;
  const job = prepared.jobs[index];
  if (!job)
    throw new Error(
      `Unknown chunk ${target}; choose 1-${prepared.jobs.length}`,
    );
  return job;
}

function isOneChunkStage(stage: EvidencePipelineStage) {
  return (
    stage === "chunk-analysis" ||
    stage === "chunk-coverage" ||
    stage === "chunk-repair" ||
    stage === "apply-chunk-repair" ||
    stage === "accept-chunk" ||
    stage === "read-chunk"
  );
}

function isAttemptStage(stage: EvidencePipelineStage) {
  return (
    stage === "chunk-analysis" ||
    stage === "chunk-coverage" ||
    stage === "chunk-repair" ||
    stage === "apply-chunk-repair"
  );
}

async function discoverAcceptedChunkResults(
  artifactRoot: string,
  prepared: PreparedCandidateChunks,
) {
  const root = join(artifactRoot, DIRECTORIES["accept-chunk"]);
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const accepted = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const artifact = JSON.parse(
          await readFile(join(root, entry.name, "output.json"), "utf8"),
        ) as EvidencePipelineArtifact;
        return artifact.selectedChunk && artifact.chunkResult
          ? [artifact.selectedChunk, artifact.chunkResult] as const
          : undefined;
      }),
  );
  const byChunk = new Map(
    accepted.filter(
      (item): item is readonly [number, ChunkReadResult] => Boolean(item),
    ),
  );
  if (byChunk.size === 0) return undefined;
  return prepared.jobs
    .map((_, index) => byChunk.get(index + 1))
    .filter((item): item is ChunkReadResult => Boolean(item));
}

async function writeNaturalOutputs(
  stage: EvidencePipelineStage,
  artifactRoot: string,
  directory: string,
  output: EvidencePipelineArtifact,
) {
  if (stage === "acquire" && output.workspace?.finalCv)
    await writeFile(
      join(directory, "extracted-text.txt"),
      `${output.workspace.finalCv}\n`,
      "utf8",
    );
  if (stage !== "prepare-chunks" || !output.prepared) return;
  if (output.workspace?.finalCv)
    await writeFile(
      join(artifactRoot, DIRECTORIES.acquire, "extracted-text.txt"),
      `${output.workspace.finalCv}\n`,
      "utf8",
    );
  const chunksDirectory = join(directory, "chunks");
  await mkdir(chunksDirectory, { recursive: true });
  await Promise.all(
    output.prepared.jobs.map((job, index) =>
      writeFile(
        join(chunksDirectory, `chunk-${String(index + 1).padStart(3, "0")}.txt`),
        `${job.chunk}\n`,
        "utf8",
      ),
    ),
  );
  await writeJson(
    join(chunksDirectory, "index.json"),
    output.prepared.jobs.map((job, index) => ({
      chunk: index + 1,
      sourceId: job.source.id,
      sourceName: job.source.name,
      locator: job.locator,
      characters: job.chunk.length,
      file: `chunk-${String(index + 1).padStart(3, "0")}.txt`,
    })),
  );
}

async function runtimeRuns(projectRoot: string) {
  return readdir(join(projectRoot, ".agent-runtime", "runs")).catch(() => []);
}

function difference(after: string[], before: string[]) {
  const existing = new Set(before);
  return after.filter((item) => !existing.has(item)).sort();
}

async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
