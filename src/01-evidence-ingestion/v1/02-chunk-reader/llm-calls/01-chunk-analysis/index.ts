import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "evidence.chunk-analysis",
  pipeline: "01-evidence-ingestion",
  name: "Individual chunk analysis",
  purpose: "Turn one bounded source chunk into provenance-preserving evidence records.",
  fanOut: "parallel-per-chunk",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["JSON Schema validation", "exact-quote audit", "source id and locator rewrite"],
} satisfies AgentCallManifest;

export { buildInput } from "./input.js";
export { command } from "./command.js";
export { outputSchema } from "./output.js";
export type { SourceChunkNotes } from "./output.js";
export { rolePrompt } from "./role-prompt.js";
