import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { synthesizeCandidateEvidence } from "../03-synthesis/index.js";
import type {
  CandidateAnalysisProgress,
  CandidateAnalysisResult,
  CandidateAnalyzer,
} from "../types.js";
import { readCandidateSourceChunksV2 } from "./reader.js";

/** Versioned one-pass evidence analyzer selected by ROLEGAIN_EVIDENCE_VERSION=v2. */
export class CodexCandidateAnalyzerV2 implements CandidateAnalyzer {
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
    const reading = await readCandidateSourceChunksV2({
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

export { readCandidateSourceChunksV2 } from "./reader.js";
