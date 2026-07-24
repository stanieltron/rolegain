import type { AgentCallManifest } from "../../../../codex-runtime/call-manifest.js";
import { command } from "./command.js";
import { buildInput, inputDescription } from "./input.js";
import { memory } from "./memory.js";
import { outputDescription, outputSchema } from "./output.js";
import { rolePrompt } from "./role-prompt.js";
import { tools } from "./tools.js";

export const manifest = {
  id: "application.schema-verify",
  pipeline: "03-match",
  name: "Application schema verification",
  purpose: "Independently audit one-to-one employer-form mapping.",
  fanOut: "parallel-per-job",
  input: inputDescription,
  output: outputDescription,
  rolePrompt,
  tools,
  memory,
  command,
  verification: ["deterministic mapping audit", "fail closed on verifier failure"],
} satisfies AgentCallManifest;

export { buildInput, command, outputSchema, rolePrompt };
export type { ApplicationSchemaVerificationOutput } from "./output.js";
