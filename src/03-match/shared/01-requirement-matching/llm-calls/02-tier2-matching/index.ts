import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "match.tier2-evidence",
  pipeline: "03-match",
  name: "Tier 2 unresolved matching",
  purpose: "Use detailed evidence only where Tier 1 could not resolve a requirement.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "row identity preservation",
    "citation allow-list",
    "no support promotion from weak claims",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, command, outputSchema };
export type { RequirementAssessmentOutput } from "./output.js";
