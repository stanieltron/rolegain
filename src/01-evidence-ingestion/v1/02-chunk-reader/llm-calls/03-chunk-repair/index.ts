import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "evidence.chunk-repair",
  pipeline: "01-evidence-ingestion",
  name: "Targeted chunk evidence repair",
  purpose: "Emit a reasoned delta for blocking coverage findings without replacing valid extraction.",
  fanOut: "parallel-per-chunk",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["JSON Schema validation", "deterministic patch merge", "independent post-repair coverage"],
} satisfies AgentCallManifest;

export { buildInput } from "./input.js";
export { command } from "./command.js";
export { outputSchema } from "./output.js";
export type { ChunkRepairPatch, ChunkRepairRemovalTarget } from "./output.js";
export { rolePrompt } from "./role-prompt.js";
