import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, buildRecoveryInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "match.requirements",
  pipeline: "03-match",
  name: "Requirement matching",
  purpose: "Map every employer requirement to explicit candidate evidence or an honest gap.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "structured-output validation",
    "canonical citation validation",
    "deterministic requirement coverage checks",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, buildRecoveryInput, command, outputSchema };
export type {
  AgentRequirementAssessment,
  RequirementAssessmentOutput,
} from "./output.js";
