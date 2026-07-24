import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { SOURCE_READER_PROMPT_VERSION } from "../../contracts/evidence.js";
import type { SourceChunkNotes } from "./llm-calls/01-chunk-analysis/index.js";
import {
  assertEvidenceAnalysisBudget,
} from "./recovery/index.js";
import {
  readAndVerifyChunk,
  type ChunkReadJob,
  type ChunkReadResult,
} from "./recovery/run-reader-with-coverage.js";
import type {
  CandidateAnalysisProgress,
  ChunkReadingResult,
  SourceNotes,
} from "../types.js";

/** Stage 2: split every pending source and run one isolated reader per chunk. */
export async function readCandidateSourceChunks(input: {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  model: string;
  onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>;
}): Promise<ChunkReadingResult> {
  const { codex, cwd, workspace, model, onProgress } = input;

  // 1–2. Select pending sources and split them into stable chunk jobs.
  const prepared = prepareCandidateSourceChunks(workspace);
  const jobs = prepared.jobs;
  await onProgress?.({
    stage: "reading",
    completed: 0,
    total: jobs.length,
    sourceName: jobs[0]?.source.name,
  });

  // 3. Run reader calls concurrently while retaining deterministic job order.
  const checkpointRoot = path.join(
    cwd,
    "data",
    "job-search",
    "analysis-checkpoints",
    workspace.candidateId,
    `${SOURCE_READER_PROMPT_VERSION}-${model}`.replace(/[^a-zA-Z0-9._-]+/g, "-"),
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
        progressWrites = progressWrites.then(() =>
          onProgress?.({
            stage: "reading",
            completed,
            total: jobs.length,
            sourceName: job.source.name,
          }),
        );
        await progressWrites;
      };

      const cached = checkpointFile
        ? await readCheckpoint(checkpointFile)
        : undefined;
      if (cached) {
        await reportCompleted();
        return cached;
      }

      const result = await readAndVerifyChunk({
        codex,
        cwd,
        model,
        job,
        normalize: normalizeChunkNotes,
      });
      if (checkpointFile) await persistCheckpoint(checkpointFile, result);
      await reportCompleted();
      return result;
    },
  );

  // 4. Join results per source and expose both raw notes and consolidated data.
  return {
    ...joinCandidateSourceChunkReadings(workspace, prepared, results),
    prepared,
    chunkResults: results,
  };
}

export interface PreparedCandidateChunks {
  jobs: ChunkReadJob[];
}

/** Deterministic fan-out preparation: source text → independently runnable jobs. */
export function prepareCandidateSourceChunks(
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
    chunkSourceWithLocators(source.content || "").map((chunk, index, chunks) => ({
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

/** Deterministic fan-in: verified chunk readings → Stage 02 reading contract. */
export function joinCandidateSourceChunkReadings(
  workspace: JobSearchWorkspace,
  prepared: PreparedCandidateChunks,
  results: ChunkReadResult[],
): ChunkReadingResult {
  if (results.length !== prepared.jobs.length)
    throw new Error(
      `Chunk join expected ${prepared.jobs.length} results, received ${results.length}`,
    );
  const extracted = new Map<string, SourceChunkNotes[]>();
  for (const [index, job] of prepared.jobs.entries()) {
    const result = results[index];
    if (!result?.notes)
      throw new Error(`Chunk join has no result for job ${index + 1}`);
    extracted.set(job.source.id, [
      ...(extracted.get(job.source.id) || []),
      result.notes,
    ]);
  }
  const sourceNotes = workspace.sources.map((source): SourceNotes => ({
    sourceId: source.id,
    kind: source.kind,
    name: source.name,
    url: source.url,
    chunks: extracted.get(source.id) || [existingSourceNotes(source)],
  }));
  return {
    sourceNotes,
    sourceInsights: consolidateSourceNotes(sourceNotes),
    totalChunks: prepared.jobs.length,
  };
}

function checkpointFor(
  root: string,
  job: {
    source: JobSearchWorkspace["sources"][number];
    index: number;
    count: number;
  },
) {
  if (job.source.kind === "cv") return undefined;
  const sourceVersion = (job.source.contentHash || job.source.id).replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  return path.join(
    root,
    sourceVersion,
    `chunk-${job.index + 1}-of-${job.count}.json`,
  );
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

function existingSourceNotes(
  source: JobSearchWorkspace["sources"][number],
): SourceChunkNotes {
  return {
    profileFacts: emptyProfileFacts(),
    profileEvidence: [],
    insights: source.insights,
    detailedNotes: "",
    claims: [],
    unknowns: [],
    prohibitedInferences: [],
  };
}

function consolidateSourceNotes(sourceNotes: SourceNotes[]) {
  return sourceNotes.map((source) => ({
    sourceId: source.sourceId,
    insights: uniqueObjects(
      source.chunks.flatMap((chunk) => chunk.insights),
      (insight) => `${insight.title}|${insight.summary}`.toLowerCase(),
    ),
    knowledgeMarkdown: source.chunks
      .map((chunk) => chunk.detailedNotes.trim())
      .filter(Boolean)
      .join("\n\n---\n\n"),
    claims: source.chunks.flatMap((chunk) => chunk.claims),
    unknowns: uniqueObjects(
      source.chunks.flatMap((chunk) => chunk.unknowns),
      (unknown) => `${unknown.field}|${unknown.reason}`.toLowerCase(),
    ),
    prohibitedInferences: uniqueObjects(
      source.chunks.flatMap((chunk) => chunk.prohibitedInferences),
      (item) => `${item.rule}|${item.reason}`.toLowerCase(),
    ),
  }));
}

export function normalizeChunkNotes(
  value: Partial<SourceChunkNotes>,
  sourceId: string,
  locator: string,
): SourceChunkNotes {
  return {
    profileFacts: value.profileFacts || emptyProfileFacts(),
    profileEvidence: (value.profileEvidence || []).map((evidence) => ({
      ...evidence,
      sourceId,
      locator,
    })),
    insights: value.insights || [],
    detailedNotes: value.detailedNotes || "",
    claims: (value.claims || []).map((claim) => ({
      ...claim,
      sourceEvidence: (claim.sourceEvidence || []).map((evidence) => ({
        ...evidence,
        sourceId,
        locator,
      })),
    })),
    unknowns: value.unknowns || [],
    prohibitedInferences: value.prohibitedInferences || [],
  };
}

function emptyProfileFacts(): SourceChunkNotes["profileFacts"] {
  return {
    name: "",
    email: "",
    phone: "",
    linkedin: "",
    github: "",
    website: "",
    location: "",
    headline: "",
    summary: "",
    skills: [],
    languages: [],
  };
}

function analysisConcurrency() {
  const configured = Number.parseInt(
    process.env.ROLEGAIN_ANALYSIS_CONCURRENCY || "3",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(6, configured))
    : 3;
}

export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const workerCount = Math.max(
    1,
    Math.min(items.length, Math.floor(concurrency) || 1),
  );
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: workerCount }, async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

export function chunkSource(
  content: string,
  maxChars = 20_000,
  overlapChars = 2_000,
) {
  return chunkSourceWithLocators(content, maxChars, overlapChars).map(
    (chunk) => chunk.content,
  );
}

export function chunkSourceWithLocators(
  content: string,
  maxChars = 20_000,
  overlapChars = 2_000,
): Array<{ content: string; locator: string }> {
  const value = content.trim();
  if (!value) return [];
  const chunks: Array<{ content: string; locator: string }> = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + maxChars);
    if (end < value.length) {
      const boundary = value.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(maxChars * 0.65)) end = boundary;
    }
    const chunk = value.slice(start, end);
    const startLine = value.slice(0, start).split("\n").length;
    const endLine = value.slice(0, end).split("\n").length;
    chunks.push({ content: chunk, locator: `lines ${startLine}-${endLine}` });
    if (end >= value.length) break;
    start = Math.max(start + 1, end - Math.min(overlapChars, maxChars - 1));
  }
  return chunks;
}

function uniqueObjects<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
