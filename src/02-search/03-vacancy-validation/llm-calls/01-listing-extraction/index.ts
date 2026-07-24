import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "search.listing-extraction",
  pipeline: "02-search",
  name: "Listing extraction",
  purpose: "Split a live list or recruitment page into concrete vacancy leads.",
  fanOut: "parallel-per-source",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "captured-link allow-list",
    "deterministic listing fallback",
    "concrete-vacancy validation",
  ],
} satisfies AgentCallManifest;

export { rolePrompt } from "./role-prompt.js";
export { buildInput, command, outputSchema };
export type { ListingExtractionOutput } from "./output.js";
