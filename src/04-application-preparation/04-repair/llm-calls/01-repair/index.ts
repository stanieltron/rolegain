import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.repair",
  pipeline: "04-application-preparation",
  name: "Bounded application repair",
  purpose: "Repair only drafts rejected by independent verification.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["failed-id allow-list", "one repair maximum", "fresh final verification"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { ApplicationRepairOutput } from "./output.js";
