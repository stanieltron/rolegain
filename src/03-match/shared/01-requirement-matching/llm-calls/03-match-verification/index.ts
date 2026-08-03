import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "match.verification",
  pipeline: "03-match",
  name: "Independent match verification",
  purpose: "Audit match completeness, classification, and grounding in a fresh context.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "fresh isolated context",
    "deterministic findings are mandatory",
    "post-repair re-verification",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, command, outputSchema };
export type { AssessmentVerificationOutput } from "./output.js";
