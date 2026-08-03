import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { productionModel } from "../../codex-runtime/call-manifest.js";
import {
  command as SOURCE_READER_COMMAND,
} from "../v1/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import {
  joinCandidateSourceChunkReadings,
  mapConcurrentOrdered,
  normalizeChunkNotes,
  prepareCandidateSourceChunks,
} from "../v1/02-chunk-reader/index.js";
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

export const EVIDENCE_INGESTION_V2_VERSION = "evidence-v2-lean-atomic-v2";

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
  const prepared = prepareCandidateSourceChunks(input.workspace);
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
    analysisConcurrency(),
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

function analysisConcurrency() {
  const configured = Number.parseInt(process.env.ROLEGAIN_ANALYSIS_CONCURRENCY || "6", 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(6, configured)) : 6;
}

function isGroundingValidationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Deterministic result gateway rejected evidence.chunk-analysis") &&
    (message.includes("SOURCE_TEXT_NOT_IN_INPUT") || message.includes("SOURCE_ID_MISMATCH"));
}
