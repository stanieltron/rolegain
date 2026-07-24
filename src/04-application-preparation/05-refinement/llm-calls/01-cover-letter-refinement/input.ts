import type { ApplicationDraft } from "../../../../contracts/job-search.js";
import type { buildApplicationContext } from "../../../01-context/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export function buildInput(input: {
  message: string;
  context: ApplicationContext;
  conversation: ApplicationDraft["coverLetterChat"];
}) {
  return `Revise the current cover letter in response to the user's latest message.

Latest user message:
${input.message}

Application and grounded evidence:
${JSON.stringify(input.context, null, 2)}

Previous visible conversation:
${JSON.stringify(input.conversation, null, 2)}

Return the complete revised cover letter and a concise response explaining what changed.`;
}

export const inputDescription =
  "Current letter, visible conversation, user instruction, and grounded context.";
