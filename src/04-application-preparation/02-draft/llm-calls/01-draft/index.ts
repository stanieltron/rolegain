import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.draft",
  pipeline: "04-application-preparation",
  name: "Application draft",
  purpose: "Draft grounded cover letters and employer-field answers.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["independent grounding verification", "deterministic form-field checks"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { ApplicationDraftOutput } from "./output.js";
