import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type {
  CandidateAnalysisProgress,
  CandidateAnalysisResult,
  CandidateAnalyzer,
} from "../types.js";
import { readCandidateSourceChunksV2 } from "./reader.js";
import {
  joinCandidateOverviewV2,
  synthesizeCandidateOverviewV2,
} from "./synthesis.js";

/** Versioned one-pass evidence analyzer selected by ROLEGAIN_EVIDENCE_VERSION=v2. */
export class CodexCandidateAnalyzerV2 implements CandidateAnalyzer {
  constructor(
    private readonly codex: CodexExecClient,
    private readonly cwd: string,
    private readonly evidenceChunkLimit?: () => Promise<number>,
  ) {}

  async analyze(
    workspace: JobSearchWorkspace,
    message?: string,
    onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>,
  ): Promise<CandidateAnalysisResult> {
    const runtime = await this.codex.start();
    if (!runtime.authenticated) throw new Error("Codex is not authenticated");
    const maxChunks = await this.evidenceChunkLimit?.();
    const [reading, synthesis] = await Promise.all([
      readCandidateSourceChunksV2({
        codex: this.codex,
        cwd: this.cwd,
        workspace,
        maxChunks,
        onProgress,
      }),
      synthesizeCandidateOverviewV2({
        codex: this.codex,
        cwd: this.cwd,
        workspace,
        message,
      }),
    ]);
    await onProgress?.({
      stage: "synthesizing",
      completed: reading.totalChunks,
      total: reading.chunkCoverage?.totalChunks ?? reading.totalChunks,
      ...(reading.chunkCoverage?.limitReached
        ? { limit: reading.chunkCoverage.limit, limitReached: true }
        : {}),
    });
    return joinCandidateOverviewV2({ workspace, reading, synthesis });
  }
}

export {
  EVIDENCE_INGESTION_V2_VERSION,
  EVIDENCE_V2_CHUNK_MAX_CHARS,
  EVIDENCE_V2_CHUNK_OVERLAP_CHARS,
  chunkSourceForAnalysisV2,
  evidenceAnalysisConcurrencyV2,
  prepareCandidateSourceChunksV2,
  readCandidateSourceChunksV2,
} from "./reader.js";
export { joinCandidateOverviewV2, synthesizeCandidateOverviewV2 } from "./synthesis.js";
