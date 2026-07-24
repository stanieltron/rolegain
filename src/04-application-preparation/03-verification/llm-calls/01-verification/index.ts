import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.verify",
  pipeline: "04-application-preparation",
  name: "Independent application verification",
  purpose: "Reject unsupported application claims and invalid field answers.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["application-id completeness", "deterministic findings override model pass"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { DeterministicApplicationFinding } from "./input.js";
export type { ApplicationVerificationOutput } from "./output.js";
