import type { JobOpportunity } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { CompanyResearchResult } from "../types.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type CompanyResearchOutput,
} from "./llm-calls/01-company-research/index.js";

/** Application-only public-web research used before drafting application content. */
export async function researchApplicationCompany(input: {
  codex: CodexExecClient;
  cwd: string;
  model: string;
  job: JobOpportunity;
}): Promise<CompanyResearchResult> {
  const runtime = await input.codex.start();
  if (!runtime.authenticated)
    throw new Error("Codex is not authenticated for company research");
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.company-research",
    role: command.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    webSearch: { mode: "live" },
    developerInstructions: rolePrompt,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    prompt: buildInput(input.job),
    cwd: input.cwd,
    sandbox: command.sandbox,
    outputSchema,
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    effort: command.effort,
    timeoutMs: command.timeoutMs,
  });
  return JSON.parse(result.finalText) as CompanyResearchOutput;
}
