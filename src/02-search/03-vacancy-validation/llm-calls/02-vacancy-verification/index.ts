import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "search.vacancy-verification",
  pipeline: "02-search",
  name: "Vacancy verification",
  purpose: "Classify and extract one concrete vacancy from a frozen page snapshot.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "page-type validation",
    "source-text grounding",
    "closed/blocked classification",
    "hard-constraint checks",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, command, outputSchema };
export type { VacancyVerificationOutput } from "./output.js";
