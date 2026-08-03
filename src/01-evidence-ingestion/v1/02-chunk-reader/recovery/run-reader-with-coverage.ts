import type { JobSearchWorkspace } from "../../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../../codex-runtime/client.js";
import { productionModel } from "../../../../codex-runtime/call-manifest.js";
import {
  buildInput as buildSourceChunkPrompt,
  command as SOURCE_READER_COMMAND,
  outputSchema as sourceChunkNotesSchema,
  rolePrompt as SOURCE_READER_INSTRUCTIONS,
  type SourceChunkNotes,
} from "../llm-calls/01-chunk-analysis/index.js";
import {
  buildInput as buildCoveragePrompt,
  command as COVERAGE_COMMAND,
  outputSchema as coverageSchema,
  rolePrompt as COVERAGE_INSTRUCTIONS,
  type ChunkCoverageVerification,
} from "../llm-calls/02-coverage-verification/index.js";
import {
  decideChunkCoverage,
  type CoverageDecision,
} from "../coverage-verification/index.js";
import {
  buildInput as buildRepairPrompt,
  command as REPAIR_COMMAND,
  outputSchema as repairSchema,
  rolePrompt as REPAIR_INSTRUCTIONS,
  type ChunkRepairPatch,
} from "../llm-calls/03-chunk-repair/index.js";
import { applyChunkRepairPatch } from "../repair/apply-chunk-repair.js";
import {
  EvidenceCoverageNeedsReviewError,
  MAX_COVERAGE_ATTEMPTS,
} from "./index.js";

export interface ChunkReadResult {
  notes: SourceChunkNotes;
  threadId: string;
  attempts?: number;
  readerThreadIds?: string[];
  coverageThreadIds?: string[];
  repairThreadIds?: string[];
  repairs?: ChunkRepairPatch[];
  coverage?: CoverageDecision;
}

export interface ChunkReadJob {
  source: JobSearchWorkspace["sources"][number];
  chunk: string;
  locator: string;
  index: number;
  count: number;
}

export interface ChunkAnalysisResult {
  notes: SourceChunkNotes;
  threadId: string;
}

export interface ChunkCoverageResult {
  verification: ChunkCoverageVerification;
  decision: CoverageDecision;
  threadId: string;
  attempt: number;
}

export interface ChunkRepairResult {
  patch: ChunkRepairPatch;
  threadId: string;
}

/** Run only the evidence.chunk-analysis LLM call for one prepared chunk. */
export async function analyzeChunkOnce(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  job: ChunkReadJob;
  recoveryFeedback?: string[];
  normalize: (
    value: Partial<SourceChunkNotes>,
    sourceId: string,
    locator: string,
  ) => SourceChunkNotes;
}): Promise<ChunkAnalysisResult> {
  const { codex, cwd, job } = input;
  const model = input.model ?? productionModel(SOURCE_READER_COMMAND);
  const readerThread = await codex.startThread({
    cwd,
    callId: "evidence.chunk-analysis",
    role: SOURCE_READER_COMMAND.role,
    sandbox: SOURCE_READER_COMMAND.threadSandbox,
    model,
    approvalPolicy: SOURCE_READER_COMMAND.approvalPolicy,
    developerInstructions: SOURCE_READER_INSTRUCTIONS,
  });
  const readerTurn = await codex.runTurn({
    threadId: readerThread.id,
    prompt: buildSourceChunkPrompt({
      source: job.source,
      chunk: job.chunk,
      index: job.index,
      count: job.count,
      locator: job.locator,
      recoveryFeedback: input.recoveryFeedback || [],
    }),
    cwd,
    sandbox: SOURCE_READER_COMMAND.sandbox,
    outputSchema: sourceChunkNotesSchema,
    model,
    approvalPolicy: SOURCE_READER_COMMAND.approvalPolicy,
    effort: SOURCE_READER_COMMAND.effort,
    timeoutMs: SOURCE_READER_COMMAND.timeoutMs,
  });
  return {
    notes: input.normalize(
      JSON.parse(readerTurn.finalText) as Partial<SourceChunkNotes>,
      job.source.id,
      job.locator,
    ),
    threadId: readerThread.id,
  };
}

/** Run only the evidence.chunk-coverage LLM call for one chunk extraction. */
export async function verifyChunkCoverageOnce(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  job: ChunkReadJob;
  extraction: SourceChunkNotes;
  attempt?: number;
}): Promise<ChunkCoverageResult> {
  const { codex, cwd, job } = input;
  const model = input.model ?? productionModel(COVERAGE_COMMAND);
  const attempt = input.attempt || 1;
  const coverageThread = await codex.startThread({
    cwd,
    callId: "evidence.chunk-coverage",
    role: COVERAGE_COMMAND.role,
    sandbox: COVERAGE_COMMAND.threadSandbox,
    model,
    approvalPolicy: COVERAGE_COMMAND.approvalPolicy,
    developerInstructions: COVERAGE_INSTRUCTIONS,
  });
  const coverageTurn = await codex.runTurn({
    threadId: coverageThread.id,
    prompt: buildCoveragePrompt({
      source: job.source,
      chunk: job.chunk,
      locator: job.locator,
      extraction: input.extraction,
      attempt,
    }),
    cwd,
    sandbox: COVERAGE_COMMAND.sandbox,
    outputSchema: coverageSchema,
    model,
    approvalPolicy: COVERAGE_COMMAND.approvalPolicy,
    effort: COVERAGE_COMMAND.effort,
    timeoutMs: COVERAGE_COMMAND.timeoutMs,
  });
  const verification = JSON.parse(
    coverageTurn.finalText,
  ) as ChunkCoverageVerification;
  return {
    verification,
    decision: decideChunkCoverage(job.chunk, verification),
    threadId: coverageThread.id,
    attempt,
  };
}

/** Run only the evidence.chunk-repair LLM call; it returns a delta, not replacement notes. */
export async function repairChunkOnce(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  job: ChunkReadJob;
  extraction: SourceChunkNotes;
  coverage: CoverageDecision;
}): Promise<ChunkRepairResult> {
  const { codex, cwd, job } = input;
  const model = input.model ?? productionModel(REPAIR_COMMAND);
  const repairThread = await codex.startThread({
    cwd,
    callId: "evidence.chunk-repair",
    role: REPAIR_COMMAND.role,
    sandbox: REPAIR_COMMAND.threadSandbox,
    model,
    approvalPolicy: REPAIR_COMMAND.approvalPolicy,
    developerInstructions: REPAIR_INSTRUCTIONS,
  });
  const repairTurn = await codex.runTurn({
    threadId: repairThread.id,
    prompt: buildRepairPrompt({
      source: job.source,
      chunk: job.chunk,
      locator: job.locator,
      extraction: input.extraction,
      coverage: input.coverage,
    }),
    cwd,
    sandbox: REPAIR_COMMAND.sandbox,
    outputSchema: repairSchema,
    model,
    approvalPolicy: REPAIR_COMMAND.approvalPolicy,
    effort: REPAIR_COMMAND.effort,
    timeoutMs: REPAIR_COMMAND.timeoutMs,
  });
  return {
    patch: JSON.parse(repairTurn.finalText) as ChunkRepairPatch,
    threadId: repairThread.id,
  };
}

/** Run reader → independent coverage → reasoned patch → merged-result verification. */
export async function readAndVerifyChunk(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  job: ChunkReadJob;
  normalize: (
    value: Partial<SourceChunkNotes>,
    sourceId: string,
    locator: string,
  ) => SourceChunkNotes;
}): Promise<ChunkReadResult> {
  const { codex, cwd, job } = input;
  const readerThreadIds: string[] = [];
  const coverageThreadIds: string[] = [];
  const repairThreadIds: string[] = [];
  const repairs: ChunkRepairPatch[] = [];

  let analysis: ChunkAnalysisResult | undefined;
  let readerError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      analysis = await analyzeChunkOnce({
        codex,
        cwd,
        model: input.model,
        job,
        normalize: input.normalize,
        recoveryFeedback:
          attempt === 1
            ? []
            : [
                "The previous reader output failed deterministic exact-source validation. Every profileEvidence.quote and sourceEvidence.quote must be one contiguous, byte-for-byte substring of this chunk. Do not join labels and sentences, normalize punctuation, or add conjunctions. Omit evidence that cannot be quoted exactly.",
              ],
      });
      break;
    } catch (error) {
      readerError = error;
      if (attempt === 2 || !isRetryableReaderValidationError(error))
        throw error;
    }
  }
  if (!analysis) throw readerError;
  readerThreadIds.push(analysis.threadId);
  let notes = analysis.notes;
  let finalCoverage: ChunkCoverageResult | undefined;
  for (let attempt = 1; attempt <= MAX_COVERAGE_ATTEMPTS; attempt += 1) {
    finalCoverage = await verifyChunkCoverageOnce({
      codex,
      cwd,
      model: input.model,
      job,
      extraction: notes,
      attempt,
    });
    coverageThreadIds.push(finalCoverage.threadId);
    if (finalCoverage.decision.passed)
      return {
        notes,
        threadId: analysis.threadId,
        attempts: attempt,
        readerThreadIds,
        coverageThreadIds,
        repairThreadIds,
        repairs,
        coverage: finalCoverage.decision,
      };
    if (attempt === MAX_COVERAGE_ATTEMPTS) break;
    const repair = await repairChunkOnce({
      codex,
      cwd,
      model: input.model,
      job,
      extraction: notes,
      coverage: finalCoverage.decision,
    });
    repairThreadIds.push(repair.threadId);
    repairs.push(repair.patch);
    notes = applyChunkRepairPatch({
      current: notes,
      patch: repair.patch,
      job,
      normalize: input.normalize,
    });
  }

  throw new EvidenceCoverageNeedsReviewError(
    job.source.name,
    job.locator,
    finalCoverage?.decision.feedback.length
      ? finalCoverage.decision.feedback
      : ["The independently verified repaired extraction remains incomplete."],
  );
}

function isRetryableReaderValidationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(
      "Deterministic result gateway rejected evidence.chunk-analysis",
    ) &&
    (message.includes("SOURCE_TEXT_NOT_IN_INPUT") ||
      message.includes("SOURCE_ID_MISMATCH"))
  );
}
