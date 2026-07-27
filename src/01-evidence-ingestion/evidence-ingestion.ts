import type { JobSearchWorkspace } from "../contracts/job-search.js";
import { CodexExecClient } from "../codex-runtime/client.js";
export {
  acquireEvidence,
  type EvidenceInput,
} from "./01-evidence-acquisition/flow.js";
import { readCandidateSourceChunks } from "./02-chunk-reader/index.js";
import { synthesizeCandidateEvidence } from "./03-synthesis/index.js";
import { verifyAndPersistEvidence } from "./04-verification/index.js";
import type {
  CandidateAnalysisProgress,
  CandidateAnalysisResult,
  CandidateAnalyzer,
} from "./types.js";

/**
 * Top-level evidence-ingestion entry points.
 *
 * JobSearchService uses acquireEvidence() for the synchronous Stage 01 request
 * phase, persists the accepted source, and then queues buildCandidateEvidence()
 * for Stages 02-04. Keeping that durable boundary prevents a failed analysis
 * from losing an already accepted source or a previously usable CV.
 *
 *   2. readCandidateSourceChunks()   reader + independent coverage per chunk,
 *                                    with bounded reasoned patch rounds
 *   3. synthesizeCandidateEvidence() one synthesis LLM call
 *   4. verifyAndPersistEvidence()    deterministic quote audit + ready state
 */

export class CodexCandidateAnalyzer implements CandidateAnalyzer {
  constructor(
    private readonly codex: CodexExecClient,
    private readonly cwd: string,
  ) {}

  async analyze(
    workspace: JobSearchWorkspace,
    message?: string,
    onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>,
  ): Promise<CandidateAnalysisResult> {
    const runtime = await this.codex.start();
    if (!runtime.authenticated) throw new Error("Codex is not authenticated");

    const reading = await readCandidateSourceChunks({
      codex: this.codex,
      cwd: this.cwd,
      workspace,
      onProgress,
    });
    return synthesizeCandidateEvidence({
      codex: this.codex,
      cwd: this.cwd,
      workspace,
      reading,
      message,
      onProgress,
    });
  }
}

/** Run the complete queued phase and return the updated in-memory workspace. */
export async function buildCandidateEvidence(input: {
  analyzer: CandidateAnalyzer;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  sourceIdsToAnalyze: ReadonlySet<string>;
  message?: string;
  onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>;
  reloadWorkspace?: () => Promise<JobSearchWorkspace>;
  beforeVerification?: () => void | Promise<void>;
}) {
  const analysis = await input.analyzer.analyze(
    input.workspace,
    input.message,
    input.onProgress,
  );
  const workspace = input.reloadWorkspace
    ? await input.reloadWorkspace()
    : input.workspace;
  await input.beforeVerification?.();
  const evidenceRun = await verifyAndPersistEvidence({
    dataRoot: input.dataRoot,
    workspace,
    analysis,
    sourceIdsToAnalyze: input.sourceIdsToAnalyze,
  });
  return { workspace, analysis, evidenceRun };
}
