import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.field-map",
  pipeline: "03-match",
  name: "Application field mapping",
  purpose: "Read a live rendered employer form and map every question to canonical candidate facts.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "rendered-control partition",
    "observed-id allow-list",
    "structural-key preservation",
    "option compatibility",
  ],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { ApplicationFieldMappingOutput } from "./output.js";
