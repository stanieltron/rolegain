import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.company-research",
  pipeline: "04-application-preparation",
  name: "Application company research",
  purpose:
    "Research the employer behind one application and derive sourced application-tailoring context.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: [
    "public HTTP(S) source validation",
    "unique source URL validation",
    "application-stage isolation",
  ],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { CompanyResearchOutput } from "./output.js";
