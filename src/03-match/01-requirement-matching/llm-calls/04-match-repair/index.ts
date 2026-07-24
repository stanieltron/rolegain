import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, buildRecoveryInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "match.repair",
  pipeline: "03-match",
  name: "Bounded match repair",
  purpose: "Repair verifier-identified defects before one final verification pass.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "failed-job allow-list",
    "one repair bound",
    "independent re-verification",
    "reject on second failure",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, buildRecoveryInput, command, outputSchema };
export type { RequirementAssessmentOutput } from "./output.js";
