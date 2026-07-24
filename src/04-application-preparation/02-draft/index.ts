import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { ApplicationContentDraft } from "../types.js";
import type { buildApplicationContext } from "../01-context/index.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type ApplicationDraftOutput,
} from "./llm-calls/01-draft/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

/** Stage 2: produce the first grounded cover letters and employer answers. */
export async function draftApplicationContent(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  contexts: ApplicationContext[];
}): Promise<ApplicationContentDraft[]> {
  if (input.contexts.length === 0) return [];
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.draft",
    role: command.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    developerInstructions: rolePrompt,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    prompt: buildInput(input.contexts),
    cwd: input.cwd,
    sandbox: command.sandbox,
    outputSchema,
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    effort: command.effort,
    timeoutMs: command.timeoutMs,
  });
  return (JSON.parse(result.finalText) as ApplicationDraftOutput).drafts;
}

export { outputSchema as draftSchema } from "./llm-calls/01-draft/index.js";
