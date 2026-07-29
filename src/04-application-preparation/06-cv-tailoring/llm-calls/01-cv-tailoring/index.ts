import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.cv-tailor",
  pipeline: "04-application-preparation",
  name: "Application CV tailoring",
  purpose:
    "Reorder and rewrite an existing CV for one application without adding unsupported facts.",
  fanOut: "single",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "minimum complete-document length",
    "original-CV factual boundary",
    "application-stage user trigger",
  ],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { CvTailoringOutput } from "./output.js";
