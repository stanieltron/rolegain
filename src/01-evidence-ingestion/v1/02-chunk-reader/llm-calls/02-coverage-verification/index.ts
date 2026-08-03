import type { AgentCallManifest } from "../../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "evidence.chunk-coverage",
  pipeline: "01-evidence-ingestion",
  name: "Independent chunk coverage verification",
  purpose: "Detect material omissions and unsupported extraction before evidence leaves the source chunk.",
  fanOut: "parallel-per-chunk",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["JSON Schema validation", "exact-quote validation", "bounded targeted recovery"],
} satisfies AgentCallManifest;

export { buildInput } from "./input.js";
export { command } from "./command.js";
export { outputSchema } from "./output.js";
export type {
  ChunkCoverageVerification,
  CoverageFinding,
} from "./output.js";
export { rolePrompt } from "./role-prompt.js";
