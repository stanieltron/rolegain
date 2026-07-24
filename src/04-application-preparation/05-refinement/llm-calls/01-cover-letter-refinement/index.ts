import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.cover-letter-refine",
  pipeline: "04-application-preparation",
  name: "Cover-letter refinement",
  purpose: "Apply user style guidance without adding unsupported facts.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["structured output schema", "supplied evidence boundary"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { CoverLetterRefinementOutput } from "./output.js";
