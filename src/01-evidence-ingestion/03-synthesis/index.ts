import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import {
  buildInput as buildSynthesisPrompt,
  command as SYNTHESIS_COMMAND,
  outputSchema as candidateSynthesisSchema,
  rolePrompt as CANDIDATE_INTELLIGENCE_INSTRUCTIONS,
  type EvidenceSynthesisOutput,
} from "./llm-calls/01-evidence-synthesis/index.js";
import type {
  CandidateAnalysisProgress,
  CandidateAnalysisResult,
  ChunkReadingResult,
} from "../types.js";

/** Stage 3: reduce all reader outputs into one candidate profile and role model. */
export async function synthesizeCandidateEvidence(input: {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  model: string;
  reading: ChunkReadingResult;
  message?: string;
  onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>;
}): Promise<CandidateAnalysisResult> {
  const { codex, cwd, workspace, model, reading, message, onProgress } = input;

  // 1. Tell the product that all reader calls have joined.
  await onProgress?.({
    stage: "synthesizing",
    completed: reading.totalChunks,
    total: reading.totalChunks,
  });

  // 2. Run one isolated reducer call over reader-produced facts and signals.
  const thread = await codex.startThread({
    cwd,
    callId: "evidence.synthesis",
    role: SYNTHESIS_COMMAND.role,
    sandbox: SYNTHESIS_COMMAND.threadSandbox,
    model,
    approvalPolicy: SYNTHESIS_COMMAND.approvalPolicy,
    developerInstructions: CANDIDATE_INTELLIGENCE_INSTRUCTIONS,
  });
  const turn = await codex.runTurn({
    threadId: thread.id,
    prompt: buildSynthesisPrompt({
      workspace,
      sourceNotes: reading.sourceNotes,
      message,
    }),
    cwd,
    sandbox: SYNTHESIS_COMMAND.sandbox,
    outputSchema: candidateSynthesisSchema,
    model,
    approvalPolicy: SYNTHESIS_COMMAND.approvalPolicy,
    effort: SYNTHESIS_COMMAND.effort,
    timeoutMs: SYNTHESIS_COMMAND.timeoutMs,
  });

  // 3. Keep source insights/claims from the readers; synthesis owns only the
  // cross-source profile, unknowns, role families and search vocabulary.
  const synthesis = JSON.parse(turn.finalText) as EvidenceSynthesisOutput;
  return {
    ...synthesis,
    threadId: thread.id,
    sourceInsights: reading.sourceInsights,
  };
}
