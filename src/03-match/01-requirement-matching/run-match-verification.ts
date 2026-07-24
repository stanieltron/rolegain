import type { JobOpportunity } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type AssessmentVerificationOutput,
} from "./llm-calls/03-match-verification/index.js";

export interface MatchVerificationCallInput {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  sourceLedger: unknown;
  opportunities: JobOpportunity[];
  assessments: unknown;
  deterministicFindings: unknown;
}

/** Execute one fresh-context reverse-verification call. */
export async function runMatchVerificationCall(
  input: MatchVerificationCallInput,
): Promise<AssessmentVerificationOutput> {
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "match.verification",
    role: command.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    developerInstructions: rolePrompt,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    cwd: input.cwd,
    sandbox: command.sandbox,
    outputSchema,
    model: input.model,
    effort: command.effort,
    timeoutMs: command.timeoutMs,
    prompt: buildInput(input),
  });
  return JSON.parse(result.finalText) as AssessmentVerificationOutput;
}
