export const EVIDENCE_CHUNK_BATCH_SIZE = 24;
export const DEFAULT_MAX_EVIDENCE_CHUNKS = EVIDENCE_CHUNK_BATCH_SIZE * 2;
export const HARD_MAX_EVIDENCE_CHUNKS = EVIDENCE_CHUNK_BATCH_SIZE * 10;

export interface EvidenceSourceChunkCoverage {
  sourceId: string;
  sourceName: string;
  analyzedChunks: number;
  totalChunks: number;
}

export interface EvidenceChunkCoverage {
  analyzedChunks: number;
  totalChunks: number;
  limit: number;
  batchSize: number;
  limitReached: boolean;
  sources: EvidenceSourceChunkCoverage[];
}

export function limitEvidenceChunkJobs<
  T extends { source: { id: string; name: string } },
>(sourceJobs: Array<{ source: T["source"]; jobs: T[] }>, limit: number) {
  const normalizedLimit = normalizeEvidenceChunkLimit(limit);
  const allJobs = sourceJobs.flatMap((group) => group.jobs);
  const jobs = allJobs.slice(0, normalizedLimit);
  const selectedBySource = jobs.reduce<Map<string, number>>((counts, job) => {
    counts.set(job.source.id, (counts.get(job.source.id) || 0) + 1);
    return counts;
  }, new Map());
  const coverage: EvidenceChunkCoverage = {
    analyzedChunks: jobs.length,
    totalChunks: allJobs.length,
    limit: normalizedLimit,
    batchSize: EVIDENCE_CHUNK_BATCH_SIZE,
    limitReached: jobs.length < allJobs.length,
    sources: sourceJobs.map(({ source, jobs: jobsForSource }) => ({
      sourceId: source.id,
      sourceName: source.name,
      analyzedChunks: selectedBySource.get(source.id) || 0,
      totalChunks: jobsForSource.length,
    })),
  };
  return { jobs, coverage };
}

export function configuredEvidenceChunkLimit(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = Number.parseInt(
    environment.ROLEGAIN_MAX_EVIDENCE_CHUNKS ||
      String(DEFAULT_MAX_EVIDENCE_CHUNKS),
    10,
  );
  return normalizeEvidenceChunkLimit(configured);
}

export function normalizeEvidenceChunkLimit(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVIDENCE_CHUNKS;
  return Math.max(
    EVIDENCE_CHUNK_BATCH_SIZE,
    Math.min(HARD_MAX_EVIDENCE_CHUNKS, Math.floor(value)),
  );
}

export function validateEvidenceChunkLimit(value: number) {
  if (
    !Number.isInteger(value) ||
    value < EVIDENCE_CHUNK_BATCH_SIZE ||
    value > HARD_MAX_EVIDENCE_CHUNKS
  )
    throw new Error(
      `Evidence chunk limit must be an integer from ${EVIDENCE_CHUNK_BATCH_SIZE} to ${HARD_MAX_EVIDENCE_CHUNKS}`,
    );
  return value;
}

export function evidenceChunkLimitWarning(coverage: EvidenceChunkCoverage) {
  if (!coverage.limitReached) return undefined;
  return `${coverage.analyzedChunks}/${coverage.totalChunks} evidence chunks were analyzed; the configured limit is ${coverage.limit}. Evidence from completed chunks was kept.`;
}

export function evidenceSourceLimitMessage(
  source: EvidenceSourceChunkCoverage,
  coverage: EvidenceChunkCoverage,
) {
  return `${source.analyzedChunks}/${source.totalChunks} chunks analyzed for this source; the run reached its configured limit of ${coverage.limit} (${coverage.analyzedChunks}/${coverage.totalChunks} total chunks). Evidence from completed chunks was kept. Remove or shorten this source, or retry after an administrator raises the limit.`;
}

export function isEvidenceChunkLimitMessage(value?: string) {
  return Boolean(
    value?.includes("the run reached its configured limit") ||
      (value?.includes("Evidence analysis needs") &&
        value.includes("exceeding the configured maximum")),
  );
}
