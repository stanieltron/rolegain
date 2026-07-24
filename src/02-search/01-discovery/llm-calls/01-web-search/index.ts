import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "search.web-discovery",
  pipeline: "02-search",
  name: "Public web search",
  purpose: "Discover live vacancy candidates across evidence-derived search lanes.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "public HTTP(S) URL validation",
    "seen-URL deduplication",
    "subsequent browser verification",
  ],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema };
export { rolePrompt } from "./role-prompt.js";
export type { WebSearchOutput } from "./output.js";
