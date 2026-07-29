import type { buildApplicationContext } from "../01-context/index.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { TailoredCvContent } from "../types.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type CvTailoringOutput,
} from "./llm-calls/01-cv-tailoring/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

/** User-triggered application-stage CV rewrite, bounded to the original CV. */
export async function tailorApplicationCv(input: {
  codex: CodexExecClient;
  cwd: string;
  model: string;
  originalCv: string;
  context: ApplicationContext;
}): Promise<TailoredCvContent> {
  const runtime = await input.codex.start();
  if (!runtime.authenticated)
    throw new Error("Codex is not authenticated for CV tailoring");
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.cv-tailor",
    role: command.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    webSearch: { mode: "disabled" },
    developerInstructions: rolePrompt,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    prompt: buildInput({
      originalCv: input.originalCv,
      context: input.context,
    }),
    cwd: input.cwd,
    sandbox: command.sandbox,
    outputSchema,
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    effort: command.effort,
    timeoutMs: command.timeoutMs,
  });
  const parsed = JSON.parse(result.finalText) as CvTailoringOutput;
  if (parsed.content.trim().length < 200)
    throw new Error("The tailored CV output was unexpectedly incomplete");
  return parsed;
}
