import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export { buildInput, command, outputDescription, outputSchema, rolePrompt, tools };

export const manifest = {
  id: "search.source-navigation",
  pipeline: "02-search",
  name: "Bounded vacancy-source navigation",
  purpose:
    "Reveal additional vacancy links on interactive or infinite-scroll listing pages without applying or authenticating.",
  fanOut: "parallel-per-source",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "bounded interaction and replay budgets",
    "same-host continuation-click validation",
    "application/authentication/consent prohibition",
  ],
} satisfies AgentCallManifest;
