import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { buildApplicationContext } from "../01-context/index.js";
import type {
  ApplicationContentDraft,
  ApplicationDraftVerification,
} from "../types.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type ApplicationRepairOutput,
} from "./llm-calls/01-repair/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

/** Stage 4: repair only applications rejected by the independent verifier. */
export async function repairApplicationDrafts(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  contexts: ApplicationContext[];
  drafts: ApplicationContentDraft[];
  failures: ApplicationDraftVerification[];
}) {
  const failedIds = new Set(
    input.failures.map((item) => item.applicationId),
  );
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.repair",
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
    prompt: buildInput({
      contexts: input.contexts,
      drafts: input.drafts,
      failures: input.failures,
    }),
  });
  const repaired = (JSON.parse(result.finalText) as ApplicationRepairOutput)
    .drafts;
  const repairedById = new Map(
    repaired
      .filter((item) => failedIds.has(item.applicationId))
      .map((item) => [item.applicationId, item]),
  );
  return input.drafts.map(
    (item) => repairedById.get(item.applicationId) || item,
  );
}
