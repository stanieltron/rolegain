import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "evidence.synthesis",
  pipeline: "01-evidence-ingestion",
  name: "Evidence synthesis and deduplication",
  purpose: "Reduce isolated reader signals into a candidate model and search vocabulary.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["JSON Schema validation", "deterministic claim consolidation", "search-readiness checks"],
} satisfies AgentCallManifest;

export { command } from "./command.js";
export { buildInput } from "./input.js";
export { outputSchema } from "./output.js";
export type { EvidenceSynthesisOutput } from "./output.js";
export { rolePrompt } from "./role-prompt.js";
