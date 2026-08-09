import { describe, expect, it } from "vitest";
import {
  configuredEvidenceChunkLimit,
  DEFAULT_MAX_EVIDENCE_CHUNKS,
  EVIDENCE_CHUNK_BATCH_SIZE,
  HARD_MAX_EVIDENCE_CHUNKS,
} from "../src/01-evidence-ingestion/chunk-budget.js";
import {
  mapConcurrentOrderedInBatches,
  prepareCandidateSourceChunks,
} from "../src/01-evidence-ingestion/v1/02-chunk-reader/index.js";
import { prepareCandidateSourceChunksV2 } from "../src/01-evidence-ingestion/v2/reader.js";
import { mockWorkspaceWithCv } from "../src/01-evidence-ingestion/inspection/fixtures.js";

describe("evidence chunk batching", () => {
  it("defaults to two 24-chunk batches with a bounded override", () => {
    expect(EVIDENCE_CHUNK_BATCH_SIZE).toBe(24);
    expect(DEFAULT_MAX_EVIDENCE_CHUNKS).toBe(48);
    expect(configuredEvidenceChunkLimit({})).toBe(48);
    expect(
      configuredEvidenceChunkLimit({ ROLEGAIN_MAX_EVIDENCE_CHUNKS: "72" }),
    ).toBe(72);
    expect(
      configuredEvidenceChunkLimit({ ROLEGAIN_MAX_EVIDENCE_CHUNKS: "999" }),
    ).toBe(HARD_MAX_EVIDENCE_CHUNKS);
  });

  it("keeps the first 48 jobs and reports per-source partial coverage", () => {
    const workspace = mockWorkspaceWithCv();
    const template = workspace.sources[0];
    workspace.sources = Array.from({ length: 60 }, (_, index) => ({
      ...template,
      id: `source-${index + 1}`,
      kind: "document" as const,
      name: `Evidence ${index + 1}`,
      content: `Evidence source ${index + 1}: implemented a durable system.`,
      status: "processing" as const,
      analysisRequired: true,
      insights: [],
    }));

    const prepared = prepareCandidateSourceChunks(workspace, 48);
    const preparedV2 = prepareCandidateSourceChunksV2(workspace, 48);

    expect(prepared.jobs).toHaveLength(48);
    expect(prepared.coverage).toMatchObject({
      analyzedChunks: 48,
      totalChunks: 60,
      limit: 48,
      batchSize: 24,
      limitReached: true,
    });
    expect(prepared.coverage.sources.slice(47, 50)).toEqual([
      expect.objectContaining({ sourceId: "source-48", analyzedChunks: 1, totalChunks: 1 }),
      expect.objectContaining({ sourceId: "source-49", analyzedChunks: 0, totalChunks: 1 }),
      expect.objectContaining({ sourceId: "source-50", analyzedChunks: 0, totalChunks: 1 }),
    ]);
    expect(preparedV2.jobs).toHaveLength(48);
    expect(preparedV2.coverage).toMatchObject({
      analyzedChunks: 48,
      totalChunks: 60,
      limitReached: true,
    });
  });

  it("does not start a second 24-item batch before the first one joins", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from({ length: 50 }, (_, index) => index);
    const output = await mapConcurrentOrderedInBatches(
      values,
      50,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return value * 2;
      },
    );

    expect(maximumActive).toBe(24);
    expect(output).toEqual(values.map((value) => value * 2));
  });
});
