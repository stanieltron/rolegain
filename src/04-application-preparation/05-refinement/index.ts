import type {
  ApplicationDraft,
  FormField,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { buildApplicationContext } from "../01-context/index.js";
import type {
  ApplicationAnswerRefinement,
  CoverLetterRefinement,
} from "../types.js";
import {
  buildInput as buildCoverLetterRefinementInput,
  command as COVER_LETTER_REFINEMENT_COMMAND,
  outputSchema as coverLetterRefinementSchema,
  rolePrompt as COVER_LETTER_REFINEMENT_INSTRUCTIONS,
  type CoverLetterRefinementOutput,
} from "./llm-calls/01-cover-letter-refinement/index.js";
import {
  buildInput as buildAnswerRefinementInput,
  command as ANSWER_REFINEMENT_COMMAND,
  outputSchema as answerRefinementSchema,
  rolePrompt as ANSWER_REFINEMENT_INSTRUCTIONS,
  type ApplicationAnswerRefinementOutput,
} from "./llm-calls/02-answer-refinement/index.js";

export async function refineCoverLetter(input: {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  model?: string;
  workspace: JobSearchWorkspace;
  application: ApplicationDraft;
  message: string;
}): Promise<CoverLetterRefinement> {
  const context = await buildApplicationContext(
    input.workspace,
    input.application,
    input.dataRoot,
  );
  const threadId = (
    await input.codex.startThread({
      cwd: input.cwd,
      callId: "application.cover-letter-refine",
      role: COVER_LETTER_REFINEMENT_COMMAND.role,
      sandbox: "read-only",
      model: input.model,
      approvalPolicy: COVER_LETTER_REFINEMENT_COMMAND.approvalPolicy,
      developerInstructions: COVER_LETTER_REFINEMENT_INSTRUCTIONS,
    })
  ).id;
  const result = await input.codex.runTurn({
    threadId,
    prompt: buildCoverLetterRefinementInput({
      message: input.message,
      context,
      conversation: input.application.coverLetterChat,
    }),
    cwd: input.cwd,
    sandbox: COVER_LETTER_REFINEMENT_COMMAND.sandbox,
    outputSchema: coverLetterRefinementSchema,
    model: input.model,
    approvalPolicy: COVER_LETTER_REFINEMENT_COMMAND.approvalPolicy,
    effort: COVER_LETTER_REFINEMENT_COMMAND.effort,
    timeoutMs: COVER_LETTER_REFINEMENT_COMMAND.timeoutMs,
  });
  const parsed = JSON.parse(result.finalText) as CoverLetterRefinementOutput;
  return { ...parsed, threadId };
}

export async function refineApplicationAnswer(input: {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  model?: string;
  workspace: JobSearchWorkspace;
  application: ApplicationDraft;
  field: FormField;
  message: string;
}): Promise<ApplicationAnswerRefinement> {
  const context = await buildApplicationContext(
    input.workspace,
    input.application,
    input.dataRoot,
  );
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.answer-refine",
    role: ANSWER_REFINEMENT_COMMAND.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: ANSWER_REFINEMENT_COMMAND.approvalPolicy,
    developerInstructions: ANSWER_REFINEMENT_INSTRUCTIONS,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    prompt: buildAnswerRefinementInput({
      field: input.field,
      message: input.message,
      context,
    }),
    cwd: input.cwd,
    sandbox: ANSWER_REFINEMENT_COMMAND.sandbox,
    outputSchema: answerRefinementSchema,
    model: input.model,
    approvalPolicy: ANSWER_REFINEMENT_COMMAND.approvalPolicy,
    effort: ANSWER_REFINEMENT_COMMAND.effort,
    timeoutMs: ANSWER_REFINEMENT_COMMAND.timeoutMs,
  });
  return JSON.parse(result.finalText) as ApplicationAnswerRefinementOutput;
}
