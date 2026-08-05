import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { productionModel } from "../../codex-runtime/call-manifest.js";
import {
  command as SOURCE_READER_COMMAND,
} from "../v1/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import {
  chunkSourceWithLocators,
  joinCandidateSourceChunkReadings,
  mapConcurrentOrdered,
  normalizeChunkNotes,
  type PreparedCandidateChunks,
} from "../v1/02-chunk-reader/index.js";
import { assertEvidenceAnalysisBudget } from "../v1/02-chunk-reader/recovery/index.js";
import {
  type ChunkReadJob,
  type ChunkReadResult,
} from "../v1/02-chunk-reader/recovery/run-reader-with-coverage.js";
import type {
  CandidateAnalysisProgress,
  ChunkReadingResult,
} from "../types.js";
import {
  buildLeanChunkInput,
  expandLeanChunkExtraction,
  leanChunkOutputSchema,
  leanChunkRolePrompt,
  type LeanChunkExtraction,
} from "./lean-contract.js";

export const EVIDENCE_INGESTION_V2_VERSION = "evidence-v2-parallel-low-v6";
export const EVIDENCE_V2_CHUNK_MAX_CHARS = 20_000;
export const EVIDENCE_V2_CHUNK_OVERLAP_CHARS = 1_500;

/**
 * Benchmark-selected Stage 02 reader.
 *
 * Each uncached chunk receives one extraction call. The existing result gateway
 * remains the deterministic exact-quote/schema boundary. A second call is used
 * only when that boundary rejects malformed grounding; there is no semantic
 * coverage verifier or repair loop on the standard path.
 */
export async function readCandidateSourceChunksV2(input: {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  model?: string;
  onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>;
}): Promise<ChunkReadingResult> {
  const model = input.model ?? productionModel(SOURCE_READER_COMMAND);
  const prepared = prepareCandidateSourceChunksV2(input.workspace);
  const jobs = prepared.jobs;
  await input.onProgress?.({
    stage: "reading",
    completed: 0,
    total: jobs.length,
    sourceName: jobs[0]?.source.name,
  });

  const checkpointRoot = path.join(
    input.cwd,
    "data",
    "job-search",
    "analysis-checkpoints",
    input.workspace.candidateId,
    `${EVIDENCE_INGESTION_V2_VERSION}-${model}`.replace(/[^a-zA-Z0-9._-]+/g, "-"),
  );
  let completedJobs = 0;
  let progressWrites = Promise.resolve();
  const results = await mapConcurrentOrdered(
    jobs,
    evidenceAnalysisConcurrencyV2(),
    async (job) => {
      const checkpointFile = checkpointFor(checkpointRoot, job);
      const reportCompleted = async () => {
        completedJobs += 1;
        const completed = completedJobs;
        progressWrites = progressWrites.then(() => input.onProgress?.({
          stage: "reading",
          completed,
          total: jobs.length,
          sourceName: job.source.name,
        }));
        await progressWrites;
      };

      const cached = checkpointFile ? await readCheckpoint(checkpointFile) : undefined;
      if (cached) {
        const result = {
          ...cached,
          notes: normalizeChunkNotes(cached.notes, job.source.id, job.locator),
        };
        await reportCompleted();
        return result;
      }

      const result = await analyzeOnePass({ ...input, model, job });
      if (checkpointFile) await persistCheckpoint(checkpointFile, result);
      await reportCompleted();
      return result;
    },
  );

  return {
    ...joinCandidateSourceChunkReadings(input.workspace, prepared, results),
    prepared,
    chunkResults: results,
  };
}

async function analyzeOnePass(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  job: ChunkReadJob;
}): Promise<ChunkReadResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const recoveryFeedback = attempt === 1 ? [] : [
          "The previous output failed deterministic exact-source validation. Every quotation must be one contiguous, byte-for-byte substring of this chunk. Omit evidence that cannot be quoted exactly.",
        ];
      const readerThread = await input.codex.startThread({
        cwd: input.cwd,
        callId: "evidence.chunk-analysis",
        role: SOURCE_READER_COMMAND.role,
        sandbox: SOURCE_READER_COMMAND.threadSandbox,
        model: input.model,
        approvalPolicy: SOURCE_READER_COMMAND.approvalPolicy,
        developerInstructions: leanChunkRolePrompt,
      });
      const readerTurn = await input.codex.runTurn({
        threadId: readerThread.id,
        prompt: buildLeanChunkInput(input.job, recoveryFeedback),
        cwd: input.cwd,
        sandbox: SOURCE_READER_COMMAND.sandbox,
        outputSchema: leanChunkOutputSchema,
        model: input.model,
        approvalPolicy: SOURCE_READER_COMMAND.approvalPolicy,
        effort: "low",
        timeoutMs: SOURCE_READER_COMMAND.timeoutMs,
      });
      const notes = normalizeChunkNotes(
        expandLeanChunkExtraction(
          JSON.parse(readerTurn.finalText) as LeanChunkExtraction,
          input.job.source,
          input.job.locator,
        ),
        input.job.source.id,
        input.job.locator,
      );
      return {
        notes,
        threadId: readerThread.id,
        attempts: attempt,
        readerThreadIds: [readerThread.id],
        coverageThreadIds: [],
        repairThreadIds: [],
        repairs: [],
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isGroundingValidationError(error)) throw error;
    }
  }
  throw lastError;
}

function checkpointFor(root: string, job: ChunkReadJob) {
  if (job.source.kind === "cv") return undefined;
  const sourceVersion = (job.source.contentHash || job.source.id).replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  return path.join(root, sourceVersion, `chunk-${job.index + 1}-of-${job.count}.json`);
}

async function readCheckpoint(file: string): Promise<ChunkReadResult | undefined> {
  try {
    const checkpoint = JSON.parse(await readFile(file, "utf8")) as ChunkReadResult;
    return checkpoint.notes && checkpoint.threadId ? checkpoint : undefined;
  } catch {
    return undefined;
  }
}

async function persistCheckpoint(file: string, checkpoint: ChunkReadResult) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(checkpoint, null, 2), "utf8");
  await rename(temporary, file);
}

export function prepareCandidateSourceChunksV2(
  workspace: JobSearchWorkspace,
): PreparedCandidateChunks {
  const sources = workspace.sources.filter(
    (source) =>
      source.analysisRequired ||
      source.status === "processing" ||
      (source.status === "ready" &&
        (source.insights.length === 0 || !source.knowledgePath)),
  );
  const jobs = sources.flatMap((source) =>
    chunkSourceForAnalysisV2(source).map((chunk, index, chunks) => ({
      source,
      chunk: chunk.content,
      locator: chunk.locator,
      index,
      count: chunks.length,
    })),
  );
  assertEvidenceAnalysisBudget(jobs.length);
  return { jobs };
}

/**
 * V2 keeps captured pages isolated, then bounds dense pages independently.
 * This prevents an unrelated page from consuming the extraction budget of its
 * neighbor while preserving stable global line locators for exact citations.
 */
export function chunkSourceForAnalysisV2(
  source: Pick<JobSearchWorkspace["sources"][number], "kind" | "content">,
) {
  const content = source.content || "";
  if (source.kind !== "webpage" && source.kind !== "portfolio")
    return chunkSourceWithLocators(
      content,
      EVIDENCE_V2_CHUNK_MAX_CHARS,
      EVIDENCE_V2_CHUNK_OVERLAP_CHARS,
    );

  const pageMatches = [...content.matchAll(/^Page:\s+(https?:\/\/\S+)/gm)];
  if (pageMatches.length === 0)
    return chunkSourceWithLocators(
      content,
      EVIDENCE_V2_CHUNK_MAX_CHARS,
      EVIDENCE_V2_CHUNK_OVERLAP_CHARS,
    );

  const chunks: Array<{ content: string; locator: string }> = [];
  const firstPageStart = pageMatches[0].index || 0;
  const preamble = content.slice(0, firstPageStart).trim();
  if (preamble) {
    chunks.push(
      ...chunkSourceWithLocators(
        preamble,
        EVIDENCE_V2_CHUNK_MAX_CHARS,
        EVIDENCE_V2_CHUNK_OVERLAP_CHARS,
      ),
    );
  }

  for (const [pageIndex, match] of pageMatches.entries()) {
    const start = match.index || 0;
    const end = pageMatches[pageIndex + 1]?.index ?? content.length;
    const page = content.slice(start, end).trim();
    const lineOffset = content.slice(0, start).split("\n").length - 1;
    const pageUrl = match[1];
    chunks.push(
      ...chunkSourceWithLocators(
        page,
        EVIDENCE_V2_CHUNK_MAX_CHARS,
        EVIDENCE_V2_CHUNK_OVERLAP_CHARS,
      ).map((chunk) => ({
        content: chunk.content,
        locator: `${pageUrl}; ${offsetLineLocator(chunk.locator, lineOffset)}`,
      })),
    );
  }
  return chunks;
}

export function evidenceAnalysisConcurrencyV2(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = Number.parseInt(
    environment.ROLEGAIN_EVIDENCE_V2_CONCURRENCY || "20",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(20, configured))
    : 20;
}

function offsetLineLocator(locator: string, lineOffset: number) {
  const match = locator.match(/^lines (\d+)-(\d+)$/);
  if (!match) return locator;
  return `lines ${Number(match[1]) + lineOffset}-${Number(match[2]) + lineOffset}`;
}

function isGroundingValidationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Deterministic result gateway rejected evidence.chunk-analysis") &&
    (message.includes("SOURCE_TEXT_NOT_IN_INPUT") || message.includes("SOURCE_ID_MISMATCH"));
}
