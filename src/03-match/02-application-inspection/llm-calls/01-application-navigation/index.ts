import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.navigate",
  pipeline: "03-match",
  name: "Safe application navigation",
  purpose: "Reveal an employer application form without submitting or consenting.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["six-step maximum", "unsafe-action rejection", "submit prohibition"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { ApplicationNavigationDecision } from "./output.js";
